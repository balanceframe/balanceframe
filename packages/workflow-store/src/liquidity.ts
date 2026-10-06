import type { Database } from 'better-sqlite3';
import type { SpaceGovernance } from './governance.js';
import type {
  GovernanceOperation,
  GovernanceResourceRef,
  HumanControlContext,
  ProvisionResourceGrantInput,
} from './governance-types.js';
import { createHash, randomUUID } from 'node:crypto';
import type {
  ActionProposal,
  CurrentHumanApproval,
  SessionCompletionPayload,
  SessionCompletionProposal,
  SessionCompletionState,
} from './types.js';
import type {
  AdmitTransferInput,
  AdmitSessionCompletionInput,
  ApproveSessionCompletionInput,
  BeginSessionCompletionWriteInput,
  FinishSessionCompletionWriteInput,
  ReconcileSessionCompletionInput,
  SessionCompletionReconciliation,
  SessionCompletionProposalView,
  SessionCompletionWriteIntentResult,
  SessionCompletionCommand,
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
  TransferApprovalSummary,
  TransferPreview,
  VisibleStoredProspectiveClaim,
  SavePolicyInput,
  SaveSpendSessionInput,
  SettlementVerifier,
  SpendSession,
  SpendSessionItem,
  SpendSessionItemInput,
  SupplementalFactsRecord,
  TransferCommand,
  TransferPlan,
  TransferProposal,
  TransferState,
  TransitionProspectiveClaimInput,
} from './liquidity-types.js';

type EligibleHumanApproval = { id: string; approval: CurrentHumanApproval };

function currentHumanApprovers(
  eligible: readonly EligibleHumanApproval[],
): readonly CurrentHumanApproval[] {
  return eligible.map(({ approval }) => approval);
}
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
              key !== 'now' &&
              key !== 'expectedVersion' &&
              key !== 'expectedClaimSetRevision' &&
              key !== 'auth',
          ),
        )
      : value;
  return createHash('sha256').update(canonical(intent)).digest('hex');
}
type CompletionCreationIntent = LiquidityActor & {
  sessionId: string;
  expectedSessionVersion: number;
  idempotencyKey: string;
  payeeName?: string;
  notes?: string;
};

function completionCreationRequest(input: CompletionCreationIntent) {
  return {
    actorId: input.actorId, budgetId: input.budgetId, sessionId: input.sessionId,
    expectedSessionVersion: input.expectedSessionVersion,
    idempotencyKey: input.idempotencyKey,
    payeeName: input.payeeName, notes: input.notes,
  };
}

type ProspectiveCreationIntent = LiquidityActor & {
  sourceId: string;
  kind: ProspectiveClaim['kind'];
  scope: ProspectiveClaim['scope'];
  idempotencyKey: string;
};

function prospectiveCreationRequest(input: ProspectiveCreationIntent) {
  return {
    actorId: input.actorId, budgetId: input.budgetId, sourceId: input.sourceId,
    kind: input.kind, scope: input.scope, idempotencyKey: input.idempotencyKey,
  };
}


const MAX_SAFE_AMOUNT = Number.MAX_SAFE_INTEGER;

function completionState(
  phase: SessionCompletionState['phase'] = 'proposed',
  outcome: SessionCompletionState['outcome'] = null,
): SessionCompletionState {
  return { phase, outcome };
}

function completionPayloadHash(payload: SessionCompletionPayload): string {
  return createHash('sha256').update(canonical(payload)).digest('hex');
}

function completionResourceRefs(payload: SessionCompletionPayload): ResourceRef[] {
  const refs: ResourceRef[] = [
    { resourceKind: 'account', resourceId: payload.manualInput.accountId },
  ];
  for (const charge of payload.categoryCharges)
    refs.push({ resourceKind: 'category', resourceId: charge.categoryId });
  for (const split of payload.manualInput.splits ?? []) {
    refs.push({ resourceKind: 'account', resourceId: split.accountId });
    refs.push({ resourceKind: 'category', resourceId: split.categoryId });
  }
  return [...new Map(refs.map((ref) => [`${ref.resourceKind}:${ref.resourceId}`, ref])).values()];
}

function completionOperations(payload: SessionCompletionPayload): GovernanceOperation[] {
  return payload.categoryCharges.map((charge): GovernanceOperation => ({
    operation: 'session_completion',
    direction: 'outgoing',
    amount: charge.amount,
    accountId: payload.manualInput.accountId,
    categoryId: charge.categoryId,
  }));
}

function transferOperations(plan: TransferPlan): GovernanceOperation[] {
  return plan.legs.map((leg): GovernanceOperation => ({
    operation: 'transfer',
    direction: 'outgoing',
    amount: leg.amount,
    sourceAccountId: leg.sourceAccountId,
    destinationAccountId: leg.destinationAccountId,
  }));
}

function completionMoneyEquals(
  left: { minorUnits: string; currency: string },
  right: { minorUnits: string; currency: string },
): boolean {
  return left.minorUnits === right.minorUnits && left.currency === right.currency;
}

function validateCompletionPayload(payload: SessionCompletionPayload, now: string): void {
  if (payload.kind !== 'session_completion' || !payload.sessionId)
    throw new Error('Invalid session completion payload');
  if (!Number.isInteger(payload.sessionVersion) || payload.sessionVersion < 1)
    throw new Error('Invalid session completion session version');
  if (!payload.intentHash || !/^[a-f0-9]{64}$/i.test(payload.materialHash))
    throw new Error('Invalid session completion hash');
  const input = payload.manualInput;
  if (
    !input ||
    !input.parentId ||
    !input.correlationId ||
    !input.accountId ||
    !Number.isSafeInteger(input.amount) ||
    input.amount >= 0 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(input.date)
  )
    throw new Error('Invalid session completion manual input');
  const inputDate = Date.parse(`${input.date}T00:00:00.000Z`);
  if (!Number.isFinite(inputDate)) throw new Error('Invalid session completion date');
  if (input.splits !== undefined) {
    if (!Array.isArray(input.splits) || input.splits.length === 0)
      throw new Error('Invalid session completion splits');
    let splitTotal = 0;
    for (const split of input.splits) {
      if (
        !Number.isSafeInteger(split.amount) ||
        split.amount >= 0 ||
        !split.accountId ||
        split.accountId !== input.accountId ||
        split.date !== input.date ||
        !split.categoryId
      )
        throw new Error('Invalid session completion split');
      splitTotal += split.amount;
      if (!Number.isSafeInteger(splitTotal)) throw new Error('Session completion split overflow');
    }
    if (splitTotal !== input.amount) throw new Error('Session completion split mismatch');
    if (input.categoryId !== undefined && input.categoryId !== null)
      throw new Error('Split completion cannot have a parent category');
  } else if (!input.categoryId) {
    throw new Error('Single completion requires a category');
  }
  if (!Array.isArray(payload.categoryCharges) || payload.categoryCharges.length === 0)
    throw new Error('Missing session completion category charges');
  const categories = new Set<string>();
  for (const charge of payload.categoryCharges) {
    if (!charge.categoryId || categories.has(charge.categoryId))
      throw new Error('Invalid session completion category charges');
    categories.add(charge.categoryId);
    positiveMoney(charge.amount);
  }
  if (payload.cooldownUntil !== null) {
    time(payload.cooldownUntil);
    if (Date.parse(payload.cooldownUntil) < inputDate)
      throw new Error('Completion cooldown precedes transaction date');
  }
  time(now);
}

function validateCompletionClaim(
  payload: SessionCompletionPayload,
  claim: LiquidityClaimBundle,
  policy: LiquidityPolicyRecord,
  session: SpendSession,
  now: string,
): void {
  if (
    !claim.id ||
    claim.state !== 'active' ||
    claim.initiated ||
    claim.creationPolicyVersion !== policy.policy.version ||
    claim.effects.length !== payload.categoryCharges.length + 1
  )
    throw new Error('Invalid session completion claim');
  future(claim.expiresAt, now);
  if (Date.parse(claim.expiresAt) > Date.parse(session.expiresAt))
    throw new Error('Completion claim exceeds session expiry');
  const expectedAccount = payload.manualInput.amount.toString().slice(1);
  const accountEffects = claim.effects.filter((effect) => effect.kind === 'account_debit');
  if (
    accountEffects.length !== 1 ||
    accountEffects[0]!.resourceId !== payload.manualInput.accountId ||
    accountEffects[0]!.categoryId !== null ||
    accountEffects[0]!.amount.minorUnits !== expectedAccount ||
    accountEffects[0]!.economicObligationId !==
      `completion:${session.id}:account:${payload.manualInput.accountId}`
  )
    throw new Error('Completion account claim mismatch');
  for (const charge of payload.categoryCharges) {
    const effects = claim.effects.filter(
      (effect) => effect.kind === 'category' && effect.resourceId === charge.categoryId,
    );
    if (
      effects.length !== 1 ||
      !completionMoneyEquals(effects[0]!.amount, charge.amount) ||
      effects[0]!.categoryId !== charge.categoryId ||
      effects[0]!.economicObligationId !== `completion:${session.id}:category:${charge.categoryId}`
    )
      throw new Error('Completion category claim mismatch');
  }
  if (claim.effects.some((effect) => effect.kind !== 'account_debit' && effect.kind !== 'category'))
    throw new Error('Unsupported completion claim effect');
}

function policyCooldownMinutes(policy: LiquidityPolicyRecord['policy'], categoryId: string): number {
  const category = policy.categoryPolicies?.find((candidate) => candidate.categoryId === categoryId);
  if (!category || category.cooldownMinutes === undefined) return 0;
  if (
    category.kind !== 'discretionary' ||
    !Number.isInteger(category.cooldownMinutes) ||
    category.cooldownMinutes < 0 ||
    category.cooldownMinutes > 10080
  )
    throw new Error('Invalid category cooldown policy');
  return category.cooldownMinutes;
}

function validateCompletionCooldown(
  payload: SessionCompletionPayload,
  policy: LiquidityPolicyRecord,
  now: string,
  admission: boolean,
): void {
  const maxMinutes = Math.max(
    ...payload.categoryCharges.map((charge) => policyCooldownMinutes(policy.policy, charge.categoryId)),
    0,
  );
  if (maxMinutes === 0) {
    if (payload.cooldownUntil !== null) throw new Error('Unexpected completion cooldown');
    return;
  }
  if (!payload.cooldownUntil) throw new Error('Missing completion cooldown');
  if (admission) {
    const expected = new Date(Date.parse(now) + maxMinutes * 60_000).toISOString();
    if (payload.cooldownUntil !== expected) throw new Error('Completion cooldown mismatch');
  } else if (Date.parse(payload.cooldownUntil) > Date.parse(now)) {
    throw new Error('Completion cooldown active; approval precondition is not met');
  }
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
type SessionObject = Record<string, unknown>;

function sessionObject(value: unknown): SessionObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid spend session');
  return value as SessionObject;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
function nonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function legacyRouteAccountIds(item: SessionObject): string[] {
  const route = item.routeSelection;
  if (route === null || typeof route !== 'object' || Array.isArray(route)) return [];
  const selection = route as SessionObject;
  const preference = selection.approvedPreference;
  const historical = selection.historicalRoute;
  const ids = [
    selection.explicitAccountId,
    selection.sessionAccountId,
    preference !== null && typeof preference === 'object' && !Array.isArray(preference)
      ? (preference as SessionObject).accountId
      : null,
    historical !== null && typeof historical === 'object' && !Array.isArray(historical)
      ? (historical as SessionObject).accountId
      : null,
  ];
  return ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

function sessionItemAccountIds(item: unknown): string[] {
  const source = sessionObject(item);
  if ('routeSelection' in source) return legacyRouteAccountIds(source);
  const accountId = optionalString(source.accountId);
  return accountId ? [accountId] : [];
}

function normalizeSessionItem(item: unknown): SpendSessionItem {
  const source = sessionObject(item);
  const route = source.routeSelection;
  const explicitAccountId = route !== null && typeof route === 'object' && !Array.isArray(route)
    ? optionalString((route as SessionObject).explicitAccountId) : null;
  const accountId = 'routeSelection' in source
    ? explicitAccountId
    : optionalString(source.accountId);
  const normalized: SessionObject = {
    id: source.id,
    categoryId: source.categoryId,
    amount: structuredClone(source.amount),
    accountId,
    purchaseAt: source.purchaseAt,
    requiredBy: source.requiredBy,
    priceProvenance:
      source.priceProvenance === undefined ? null : structuredClone(source.priceProvenance),
  };
  for (const key of ['quantity', 'priority', 'categoryAllocations', 'barcode'] as const)
    if (source[key] !== undefined) normalized[key] = structuredClone(source[key]);
  return normalized as SpendSessionItem;
}

function normalizeSpendSession(value: unknown): SpendSession {
  const source = sessionObject(value);
  if (!Array.isArray(source.items)) throw new Error('Invalid spend session items');
  const spaceId = source.spaceId;
  const membershipId = source.membershipId;
  const governancePolicyVersion = source.governancePolicyVersion;
  if (!nonBlankString(spaceId) || !nonBlankString(membershipId) ||
      !nonBlankString(governancePolicyVersion))
    throw new Error('Spend session governance provenance unavailable');
  const accountId = optionalString(source.accountId);
  const session: SessionObject = {
    actorId: source.actorId,
    spaceId,
    membershipId,
    governancePolicyVersion,
    budgetId: source.budgetId,
    id: source.id,
    version: source.version,
    items: source.items.map((item) => normalizeSessionItem(item)),
    accountId,
    expiresAt: source.expiresAt,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
  for (const key of ['adjustments', 'warningThresholds'] as const)
    if (source[key] !== undefined) session[key] = structuredClone(source[key]);
  return session as unknown as SpendSession;
}

function validateSessionItem(item: SpendSessionItem, expiresAt: string): void {
  if (typeof item.id !== 'string' || !item.id) throw new Error('Invalid session item ID');
  if (typeof item.categoryId !== 'string' || !item.categoryId)
    throw new Error('Invalid session item category');
  positiveMoney(item.amount);
  time(item.purchaseAt);
  time(item.requiredBy);
  if (Date.parse(item.requiredBy) > Date.parse(expiresAt))
    throw new Error('Session item exceeds expiry');
  if (item.quantity !== undefined && (!Number.isInteger(item.quantity) || item.quantity <= 0))
    throw new Error('Invalid session item quantity');
  if (
    item.priority !== undefined &&
    !['required', 'planned', 'optional'].includes(item.priority)
  )
    throw new Error('Invalid session item priority');
  if (item.categoryAllocations !== undefined) {
    if (!Array.isArray(item.categoryAllocations)) throw new Error('Invalid category allocations');
    for (const allocation of item.categoryAllocations) {
      if (!allocation.categoryId) throw new Error('Invalid category allocation');
      positiveMoney(allocation.amount);
    }
  }
  if (item.priceProvenance !== undefined && item.priceProvenance !== null) {
    const provenance = sessionObject(item.priceProvenance);
    if (provenance.kind !== 'current_session_manual' && provenance.kind !== 'outside_price')
      throw new Error('Invalid price provenance');
    if (typeof provenance.observedAt !== 'string') throw new Error('Invalid price provenance');
    time(provenance.observedAt);
    if (typeof provenance.estimate !== 'boolean') throw new Error('Invalid price provenance');
    if (
      provenance.kind === 'outside_price' &&
      (!nonBlankString(provenance.source) ||
        (provenance.store !== undefined &&
          provenance.store !== null &&
          !nonBlankString(provenance.store)))
    )
      throw new Error('Invalid price provenance');
  }
  if (item.barcode !== undefined && typeof item.barcode !== 'string')
    throw new Error('Invalid barcode');
  if (item.accountId !== null && typeof item.accountId !== 'string')
    throw new Error('Invalid session account');
}

function validateSessionExtras(
  adjustments: unknown,
  warningThresholds: unknown,
): void {
  if (adjustments !== undefined) {
    if (!Array.isArray(adjustments)) throw new Error('Invalid session adjustments');
    for (const adjustment of adjustments) {
      const value = sessionObject(adjustment);
      if (!['tax', 'fee', 'discount'].includes(String(value.kind)))
        throw new Error('Invalid session adjustment');
      if (typeof value.categoryId !== 'string' || !value.categoryId)
        throw new Error('Invalid session adjustment category');
      positiveMoney(value.amount as { minorUnits: string; currency: string });
    }
  }
  if (warningThresholds !== undefined) {
    if (!Array.isArray(warningThresholds)) throw new Error('Invalid session warning thresholds');
    for (const threshold of warningThresholds) {
      const value = sessionObject(threshold);
      if (typeof value.id !== 'string' || !value.id)
        throw new Error('Invalid session warning threshold');
      if (value.basis !== 'cart_total' && value.basis !== 'category_charge')
        throw new Error('Invalid session warning threshold');
      if (value.basis === 'category_charge' &&
        (typeof value.categoryId !== 'string' || !value.categoryId))
        throw new Error('Invalid session warning threshold category');
      positiveMoney(value.maximum as { minorUnits: string; currency: string });
    }
  }
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

/** Typed transfer specialization of the shared action/approval/idempotency/audit tables.
 * All callbacks are synchronous trusted application capabilities, never request bodies.
 */
export class LiquidityWorkflow {
  constructor(
    private readonly db: Database,
    private readonly mapProposal: (row: unknown) => ActionProposal,
    private readonly governance: SpaceGovernance,
  ) {}

  private principalAgent(input: LiquidityActor): string | undefined {
    if (input.agentId) return input.agentId;
    return input.auth?.method === 'api-key' && input.auth.principalType === 'agent'
      ? input.auth.actorId
      : undefined;
  }

  private spaceContext(input: LiquidityActor): {
    spaceId: string;
    membershipId: string | null;
    governancePolicyVersion: string;
    now: string;
  } | null {
    const now = input.now ?? new Date().toISOString();
    const space = input.spaceId
      ? this.governance.getSpace({ spaceId: input.spaceId })
      : this.governance.getSpaceForBudget({ budgetId: input.budgetId });
    if (!space || space.budgetId !== input.budgetId ||
        (input.spaceId !== undefined && input.spaceId !== space.id)) return null;
    const policy = this.governance.getPolicy({ spaceId: space.id });
    if (!policy || (input.governancePolicyVersion !== undefined &&
      input.governancePolicyVersion !== policy.version)) return null;
    if (this.principalAgent(input))
      return { spaceId: space.id, membershipId: null, governancePolicyVersion: policy.version, now };
    const membership = this.governance.getCurrentMembership({
      spaceId: space.id,
      actorId: input.actorId,
      now,
    });
    if (!membership || (input.membershipId !== undefined && input.membershipId !== membership.id)) return null;
    return { spaceId: space.id, membershipId: membership.id, governancePolicyVersion: policy.version, now };
  }
  private currentMemberContext(input: LiquidityActor): {
    spaceId: string;
    membershipId: string;
    governancePolicyVersion: string;
    now: string;
  } | null {
    const context = this.spaceContext(input);
    return context?.membershipId
      ? { ...context, membershipId: context.membershipId }
      : null;
  }



  /** Trusted fixture/bootstrap path; transport management uses governance.setResourceGrant. */
  setResourceGrant(input: ResourceGrant): void {
    time(input.now);
    if (input.capability === 'full-read' &&
        (input.resourceKind !== 'budget' || input.resourceId !== input.budgetId))
      throw new Error('Full-read is a selected-budget-only resource capability');
    const context = this.spaceContext(input);
    if (!context?.membershipId) throw new Error('Current governed membership unavailable');
    this.governance.provisionResourceGrant({
      spaceId: context.spaceId,
      actorId: input.actorId,
      budgetId: input.budgetId,
      membershipId: input.membershipId ?? context.membershipId,
      capability: input.capability,
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      granted: input.granted,
      restrictions: input.restrictions,
      now: input.now,
    });
  }

  /** Manages one scoped grant after fresh human-session authorization. */
  manageResourceGrant(input: ResourceGrant & {
    managerId: string;
    auth: HumanControlContext;
  }): void {
    if (input.managerId !== input.auth.actorId) throw new Error('Resource authorization denied');
    const target = this.spaceContext({
      actorId: input.actorId,
      budgetId: input.budgetId,
      ...(input.spaceId === undefined ? {} : { spaceId: input.spaceId }),
      ...(input.membershipId === undefined ? {} : { membershipId: input.membershipId }),
      now: input.now,
    });
    if (!target?.membershipId) throw new Error('Target membership unavailable');
    this.governance.setResourceGrant({
      spaceId: target.spaceId,
      actorId: input.actorId,
      budgetId: input.budgetId,
      membershipId: input.membershipId ?? target.membershipId,
      capability: input.capability,
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      granted: input.granted,
      restrictions: input.restrictions,
      now: input.now,
      auth: input.auth,
    });
  }

  /** Evaluates an exact resource through the shared current-space policy and grant authority. */
  isAuthorized(input: LiquidityActor & ResourceRef & {
    capability: ResourceCapability;
    operation?: string;
    phase?: 'read' | 'propose' | 'approve' | 'execute';
    visibility?: 'aggregate' | 'resource';
    operations?: readonly GovernanceOperation[];
    resources?: readonly GovernanceResourceRef[];
    verifiedHumanApproval?: true;
  }): boolean {
    if (input.auth && input.auth.actorId !== input.actorId) return false;
    const context = this.spaceContext(input);
    const agentId = this.principalAgent(input);
    if (!context || (!agentId && !context.membershipId)) return false;
    const space = this.governance.getSpace({ spaceId: context.spaceId });
    const policy = space && this.governance.getPolicy({ spaceId: space.id });
    if (!space || !policy) return false;
    const phase = input.phase ?? (
      input.capability === 'approval' ? 'approve'
        : input.capability === 'proposal' || input.capability.endsWith('.propose') ? 'propose'
          : input.capability === 'confirmation' || input.capability === 'initiation-report' ? 'execute'
            : 'read'
    );
    const delegationId = input.delegationId ??
      (input.auth?.method === 'api-key' && input.auth.principalType === 'agent'
        ? input.auth.delegationId
        : undefined);
    const delegationVersion = input.auth?.method === 'api-key' && input.auth.principalType === 'agent'
      ? input.auth.delegationVersion
      : undefined;
    const authorization = this.governance.authorize({
      actorId: input.actorId,
      spaceId: context.spaceId,
      ...(input.membershipId ?? context.membershipId
        ? { membershipId: input.membershipId ?? context.membershipId! }
        : {}),
      expectedPolicyVersion: input.governancePolicyVersion ?? policy.version,
      phase,
      operation: input.operation ?? input.capability,
      required: [{
        capability: input.capability,
        resourceKind: input.resourceKind,
        resourceId: input.resourceId,
        ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
      }],
      payload: {
        operations: input.operations ?? [],
        ...(input.resources === undefined ? {} : { resources: input.resources }),
      },
      now: context.now,
      ...(agentId === undefined ? {} : { agentId }),
      ...(delegationId === undefined ? {} : { delegationId }),
      ...(delegationVersion === undefined ? {} : { delegationVersion }),
      ...(input.auth === undefined ? {} : { auth: input.auth }),
      ...(input.verifiedHumanApproval === true ? { verifiedHumanApproval: true } : {}),
    });
    return authorization.allowed &&
      (phase !== 'execute' || authorization.disposition.kind === 'authorized_without_approval');
  }

  /** Throws unless the exact space membership and scoped resource grant are current. */
  requireResource(input: LiquidityActor & ResourceRef & {
    capability: ResourceCapability;
    operation?: string;
    phase?: 'read' | 'propose' | 'approve' | 'execute';
    visibility?: 'aggregate' | 'resource';
    operations?: readonly GovernanceOperation[];
  }): void {
    if (!this.isAuthorized(input)) throw new Error('Resource authorization denied');
  }

  /** Loads trusted server-only state after current resource or aggregate conclusion admission. */
  loadEvaluationState(input: LiquidityActor & { now: string }): {
    policy: LiquidityPolicyRecord | null;
    supplemental: SupplementalFactsRecord | null;
    claimSet: LiquidityClaimSet;
    priorAllocation: { sequence: number; allocation: BackingAllocation } | null;
  } {
    const conclusion = {
      ...input,
      resourceKind: 'budget' as const,
      resourceId: input.budgetId,
      capability: 'conclusion' as const,
    };
    if (
      !this.isAuthorized({ ...conclusion, visibility: 'resource' }) &&
      !this.isAuthorized({ ...conclusion, visibility: 'aggregate' })
    )
      throw new Error('Resource authorization denied');
    return this.db
      .transaction(() => {
        let policy: LiquidityPolicyRecord | null = null;
        try {
          policy = this.currentPolicy(input.budgetId);
        } catch {
          /* Absent financial policy remains a setup state, not an authorization bypass. */
        }
        const facts = this.db
          .prepare('SELECT * FROM liquidity_supplemental_facts WHERE budget_id=? ORDER BY version DESC LIMIT 1')
          .get(input.budgetId) as
          | {
              version: number;
              facts: string;
              actor_id: string;
              expires_at: string;
              created_at: string;
              space_id: string | null;
              membership_id: string | null;
            }
          | undefined;
        const factsMembership = facts?.space_id && facts.membership_id
          ? this.governance.getCurrentMembership({
              spaceId: facts.space_id,
              actorId: facts.actor_id,
              now: input.now,
            })
          : null;
        const allocation = this.db
          .prepare('SELECT sequence,allocation FROM liquidity_allocations WHERE budget_id=? ORDER BY sequence DESC LIMIT 1')
          .get(input.budgetId) as { sequence: number; allocation: string } | undefined;
        return {
          policy,
          supplemental: facts && factsMembership?.id === facts.membership_id
            ? {
                actorId: facts.actor_id,
                budgetId: input.budgetId,
                spaceId: facts.space_id!,
                membershipId: facts.membership_id!,
                version: facts.version,
                observations: JSON.parse(facts.facts),
                expiresAt: facts.expires_at,
                createdAt: facts.created_at,
              }
            : null,
          claimSet: this.claimSet(input.budgetId, input.now, input.actorId),
          priorAllocation: allocation
            ? { sequence: allocation.sequence, allocation: JSON.parse(allocation.allocation) as BackingAllocation }
            : null,
        };
      })
      .immediate();
  }

  /** Lists active space members and grant history for a caller with grant-management authority. */
  getResourceGrantCatalog(input: LiquidityActor): {
    members: { actorId: string }[];
    grants: Omit<ResourceGrant, 'budgetId' | 'now'>[];
  } {
    const context = this.spaceContext(input);
    const space = context && this.governance.getSpace({ spaceId: context.spaceId });
    if (!space || !this.isAuthorized({
      ...input,
      spaceId: space.id,
      resourceKind: 'space',
      resourceId: space.id,
      capability: 'grant:manage',
      operation: 'grant:manage',
    })) throw new Error('Grant management authorization denied');
    const membersByActor: Record<string, { actorId: string }> = {};
    for (const period of this.governance.listMembershipHistory({ spaceId: space.id })) {
      if (this.governance.getCurrentMembership({ spaceId: space.id, actorId: period.actorId, now: context.now })?.id === period.id)
        membersByActor[period.actorId] = { actorId: period.actorId };
    }
    return {
      members: Object.values(membersByActor),
      grants: this.governance.listResourceGrants({ spaceId: space.id }).map((grant) => ({
        spaceId: grant.spaceId,
        membershipId: grant.membershipId ?? undefined,
        actorId: grant.actorId,
        resourceKind: grant.resourceKind,
        resourceId: grant.resourceId,
        capability: grant.capability as ResourceCapability,
        granted: grant.granted,
        restrictions: grant.restrictions,
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
    const resources: ResourceRef[] = plan.legs.flatMap((leg) => [
      { resourceKind: 'account', resourceId: leg.sourceAccountId },
      { resourceKind: 'account', resourceId: leg.destinationAccountId },
      { resourceKind: 'account', resourceId: leg.sourceBefore.accountId },
      { resourceKind: 'account', resourceId: leg.destinationBefore.accountId },
    ]);
    for (const line of plan.backingAfter.lines)
      resources.push(
        { resourceKind: 'account', resourceId: line.accountId },
        { resourceKind: 'category', resourceId: line.categoryId },
      );
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
  private authorizeGovernanceRequest(
    input: LiquidityActor,
    operation: string,
    capability: ResourceCapability,
    required: readonly {
      readonly capability: string;
      readonly resourceKind: ResourceRef['resourceKind'];
      readonly resourceId: string;
      readonly visibility?: 'aggregate' | 'resource';
    }[],
    operations: readonly GovernanceOperation[],
    resources: readonly ResourceRef[],
    verifiedHumanApproval = false,
    phaseOverride?: 'read' | 'propose' | 'approve' | 'execute',
  ): void {
    const context = this.spaceContext(input);
    if (!context) throw new Error('Resource authorization denied');
    const phase: 'read' | 'propose' | 'approve' | 'execute' = phaseOverride ?? (
      capability === 'approval' ? 'approve'
        : capability === 'proposal' || capability.endsWith('.propose') ? 'propose'
          : capability === 'confirmation' || capability === 'initiation-report' ? 'execute'
            : 'read'
    );
    const agentId = this.principalAgent(input);
    const delegationId = input.delegationId ??
      (input.auth?.method === 'api-key' && input.auth.principalType === 'agent'
        ? input.auth.delegationId
        : undefined);
    const delegationVersion = input.auth?.method === 'api-key' && input.auth.principalType === 'agent'
      ? input.auth.delegationVersion
      : undefined;
    const authorization = this.governance.authorize({
      actorId: input.actorId,
      spaceId: context.spaceId,
      ...(input.membershipId ?? context.membershipId
        ? { membershipId: input.membershipId ?? context.membershipId! }
        : {}),
      expectedPolicyVersion: input.governancePolicyVersion ?? context.governancePolicyVersion,
      phase,
      operation,
      required,
      payload: { operations, resources },
      now: context.now,
      ...(agentId === undefined ? {} : { agentId }),
      ...(delegationId === undefined ? {} : { delegationId }),
      ...(delegationVersion === undefined ? {} : { delegationVersion }),
      ...(input.auth === undefined ? {} : { auth: input.auth }),
      ...(verifiedHumanApproval ? { verifiedHumanApproval: true as const } : {}),
    });
    if (!authorization.allowed ||
        (phase === 'execute' && authorization.disposition.kind !== 'authorized_without_approval'))
      throw new Error('Resource authorization denied');
  }
  private authorizePlan(
    input: LiquidityActor,
    plan: TransferPlan,
    capability: ResourceCapability,
    verifiedHumanApproval = false,
    phaseOverride?: 'read' | 'propose' | 'approve' | 'execute',
    aggregateBudgetConclusion = false,
  ): void {
    const resources = this.resources(plan);
    const required: {
      capability: string;
      resourceKind: ResourceRef['resourceKind'];
      resourceId: string;
      visibility?: 'aggregate';
    }[] = aggregateBudgetConclusion
      ? [{
          capability,
          resourceKind: 'budget',
          resourceId: input.budgetId,
          visibility: 'aggregate',
        }]
      : [{ capability, resourceKind: 'budget', resourceId: input.budgetId }];
    if (!aggregateBudgetConclusion)
      for (const resource of resources) required.push({ ...resource, capability });
    if (['proposal', 'approval', 'initiation-report', 'liquidity'].includes(capability))
      for (const leg of plan.legs)
        required.push({
          capability: 'source',
          resourceKind: 'account',
          resourceId: leg.sourceAccountId,
        });
    this.authorizeGovernanceRequest(
      input,
      'transfer',
      capability,
      required,
      transferOperations(plan),
      resources,
      verifiedHumanApproval,
      phaseOverride,
    );
  }
  /** Checks current complete-plan authority; private field visibility remains independently required. */
  isTransferPlanAuthorized(
    input: LiquidityActor & {
      plan: TransferPlan;
      capability: ResourceCapability;
      phase?: 'read' | 'propose' | 'approve' | 'execute';
    },
  ): boolean {
    try {
      this.authorizePlan(
        input,
        input.plan,
        input.capability,
        false,
        input.phase,
        input.capability === 'conclusion' && input.phase === 'read',
      );
      return true;
    } catch (error) {
      if (error instanceof Error && error.message === 'Resource authorization denied') return false;
      throw error;
    }
  }
  private load(id: string): TransferProposal {
    const row = this.db.prepare('SELECT * FROM action_proposals WHERE id=?').get(id);
    if (!row) throw new Error('Proposal unavailable');
    const p = this.mapProposal(row);
    if (p.operation !== 'transfer') throw new Error('Unsupported operation');
    return p;
  }
  private loadCompletion(id: string): SessionCompletionProposal {
    const row = this.db.prepare('SELECT * FROM action_proposals WHERE id=?').get(id);
    if (!row) throw new Error('Proposal unavailable');
    const proposal = this.mapProposal(row);
    if (proposal.operation !== 'session_completion')
      throw new Error('Unsupported operation');
    return proposal;
  }
  private proposalOrigin(proposalId: string, now: string): LiquidityActor | null {
    const row = this.db.prepare(`SELECT budget_id,actor_id,space_id,requester_membership_id,
      requester_delegation_id,requester_delegation_version,governance_policy_version
      FROM action_proposals WHERE id=?`).get(proposalId) as {
      budget_id: string;
      actor_id: string;
      space_id: string | null;
      requester_membership_id: string | null;
      requester_delegation_id: string | null;
      requester_delegation_version: string | null;
      governance_policy_version: string | null;
    } | undefined;
    if (!row?.space_id || !row.requester_membership_id || !row.governance_policy_version) return null;
    const space = this.governance.getSpace({ spaceId: row.space_id });
    if (!space || space.budgetId !== row.budget_id) return null;
    const membership = this.governance
      .listMembershipHistory({ spaceId: space.id })
      .find(({ id }) => id === row.requester_membership_id);
    if (!membership || this.governance.getCurrentMembership({
      spaceId: space.id,
      actorId: membership.actorId,
      now,
    })?.id !== membership.id || this.governance.getPolicy({ spaceId: space.id })?.version !==
      row.governance_policy_version)
      return null;
    const origin: LiquidityActor = {
      actorId: row.actor_id,
      budgetId: row.budget_id,
      spaceId: space.id,
      membershipId: membership.id,
      governancePolicyVersion: row.governance_policy_version,
      now,
    };
    const hasDelegationId = row.requester_delegation_id !== null;
    const hasDelegationVersion = row.requester_delegation_version !== null;
    if (hasDelegationId !== hasDelegationVersion) return null;
    if (!hasDelegationId) return membership.actorId === row.actor_id ? origin : null;
    if (membership.actorId === row.actor_id) return null;
    const delegation = this.governance
      .listDelegations({ spaceId: space.id, agentId: row.actor_id })
      .find(({ id, version }) =>
        id === row.requester_delegation_id && version === row.requester_delegation_version);
    const agent = this.governance.getAgent({ agentId: row.actor_id });
    const nowMillis = Date.parse(now);
    const validFrom = delegation ? Date.parse(delegation.validFrom) : Number.NaN;
    const validUntil = delegation?.validUntil === null || delegation?.validUntil === undefined
      ? null
      : Date.parse(delegation.validUntil);
    if (!delegation || delegation.revokedAt !== null ||
        delegation.spaceId !== space.id || delegation.agentId !== row.actor_id ||
        delegation.issuerActorId !== membership.actorId ||
        delegation.issuerMembershipId !== membership.id ||
        agent?.registeredSpaceId !== space.id || agent.status !== 'active' ||
        !Number.isFinite(nowMillis) || !Number.isFinite(validFrom) || validFrom > nowMillis ||
        delegation.validUntil !== null &&
          (validUntil === null || !Number.isFinite(validUntil) || nowMillis >= validUntil))
      return null;
    const binding = this.governance.listCredentialBindings({ spaceId: space.id }).find((item) =>
      item.principalType === 'agent' &&
      item.principalId === row.actor_id &&
      item.credentialOwnerId === membership.actorId &&
      item.delegationId === delegation.id &&
      item.delegationVersion === delegation.version &&
      item.issuerMembershipId === membership.id &&
      item.revokedAt === null);
    if (!binding) return null;
    return {
      ...origin,
      agentId: row.actor_id,
      delegationId: delegation.id,
      auth: {
        method: 'api-key',
        actorId: row.actor_id,
        credentialId: binding.credentialId,
        credentialOwnerId: binding.credentialOwnerId,
        principalType: 'agent',
        delegationId: delegation.id,
        delegationVersion: delegation.version,
      },
    };
  }

  private hasVerifiedSessionCompletion(budgetId: string, sessionId: string): boolean {
    return !!this.db.prepare(
      "SELECT 1 FROM action_proposals WHERE budget_id=? AND operation='session_completion' AND json_extract(payload,'$.sessionId')=? AND json_extract(state,'$.phase')='verified' LIMIT 1",
    ).get(budgetId, sessionId);
  }
  private authorizeCompletion(
    input: LiquidityActor,
    payload: SessionCompletionPayload,
    capability: ResourceCapability,
    verifiedHumanApproval = false,
    phaseOverride?: 'read' | 'propose' | 'approve' | 'execute',
  ): void {
    const resources = completionResourceRefs(payload);
    const required: {
      capability: string;
      resourceKind: ResourceRef['resourceKind'];
      resourceId: string;
    }[] = [{ capability, resourceKind: 'budget', resourceId: input.budgetId }];
    for (const resource of resources) {
      required.push({
        ...resource,
        capability: 'liquidity',
      });
      required.push({ ...resource, capability });
    }
    this.authorizeGovernanceRequest(
      input,
      'session_completion',
      capability,
      required,
      completionOperations(payload),
      resources,
      verifiedHumanApproval,
      phaseOverride,
    );
  }
  private requireHumanReconciliation(input: LiquidityActor & { now: string }): void {
    const auth = input.auth;
    const nowMillis = Date.parse(input.now);
    const reauthenticatedAt = auth?.method === 'human-session'
      ? Date.parse(auth.reauthenticatedAt)
      : Number.NaN;
    if (
      !auth ||
      auth.method !== 'human-session' ||
      auth.actorId !== input.actorId ||
      !auth.sessionId.trim() ||
      input.agentId !== undefined ||
      input.delegationId !== undefined ||
      !Number.isFinite(nowMillis) ||
      !Number.isFinite(reauthenticatedAt) ||
      reauthenticatedAt > nowMillis ||
      nowMillis - reauthenticatedAt > 300_000
    )
      throw new Error('Current human reconciliation required');
  }
  private completionSession(
    input: LiquidityActor,
    payload: SessionCompletionPayload,
    now: string,
    allowExpired = false,
    requireOwner = false,
    allowChanged = false,
  ): SpendSession {
    const row = this.db
      .prepare('SELECT * FROM spend_sessions WHERE budget_id=? AND id=?')
      .get(input.budgetId, payload.sessionId) as
      { record: string; space_id: string | null; membership_id: string | null } | undefined;
    if (!row) throw new Error('Session unavailable');
    const stored = sessionObject(JSON.parse(row.record));
    const session = normalizeSpendSession(stored);
    if (row.space_id === null || row.membership_id === null) {
      if (!allowChanged) throw new Error('Session membership provenance unavailable');
    } else if (stored.spaceId !== row.space_id || stored.membershipId !== row.membership_id) {
      throw new Error('Session membership provenance mismatch');
    } else if (!allowChanged && this.governance.getCurrentMembership({
      spaceId: row.space_id,
      actorId: session.actorId,
      now,
    })?.id !== row.membership_id) {
      throw new Error('Session membership is no longer current');
    }
    if (!allowChanged && session.governancePolicyVersion !==
        this.governance.getPolicy({ spaceId: session.spaceId })?.version)
      throw new Error('Session governance policy version is no longer current');
    if (requireOwner && session.actorId !== input.actorId)
      throw new Error('Session authorization denied');
    if (!allowChanged && session.version !== payload.sessionVersion)
      throw new Error('Session changed');
    if (allowChanged || session.actorId !== input.actorId) this.budget(input, 'session');
    else this.sessionResources(input, {
      items: Array.isArray(stored.items) ? stored.items : [],
      accountId: optionalString(stored.accountId),
      adjustments: stored.adjustments,
      warningThresholds: stored.warningThresholds,
    });
    if (!allowExpired) future(session.expiresAt, now);
    return session;
  }
  private completionCommand(
    input: SessionCompletionCommand,
    capability: ResourceCapability,
    verifiedHumanApproval = false,
  ): { proposal: SessionCompletionProposal; session: SpendSession } {
    const proposal = this.loadCompletion(input.proposalId);
    if (proposal.budgetId !== input.budgetId) throw new Error('Resource authorization denied');
    if (proposal.payloadHash !== input.payloadHash) throw new Error('Payload hash mismatch');
    validateCompletionPayload(proposal.payload, input.now);
    if (['proposed', 'approved'].includes(proposal.state.phase)) {
      const origin = this.proposalOrigin(proposal.id, input.now);
      if (!origin) throw new Error('Pending proposal provenance is no longer current');
      this.authorizeCompletion(origin, proposal.payload, 'proposal', false, 'propose');
    }
    this.authorizeCompletion(input, proposal.payload, capability, verifiedHumanApproval);
    const session = this.completionSession(input, proposal.payload, input.now);
    return { proposal, session };
  }
  private completionApprovals(
    proposal: SessionCompletionProposal,
    now: string,
    includeConsumed = false,
  ): EligibleHumanApproval[] {
    if (!proposal.spaceId || !proposal.governancePolicyVersion) return [];
    const rows = this.db
      .prepare(includeConsumed
        ? "SELECT id,actor_id,status,expires_at,created_at,issuer_membership_id,governance_policy_version,reauthenticated_session_id,reauthenticated_at FROM proposal_approvals WHERE proposal_id=? AND payload_hash=? AND superseded_at IS NULL AND ((status='active' AND consumed_at IS NULL AND expires_at>?) OR (status='consumed' AND consumed_at IS NOT NULL)) ORDER BY created_at DESC,id"
        : "SELECT id,actor_id,status,expires_at,created_at,issuer_membership_id,governance_policy_version,reauthenticated_session_id,reauthenticated_at FROM proposal_approvals WHERE proposal_id=? AND payload_hash=? AND status='active' AND consumed_at IS NULL AND superseded_at IS NULL AND expires_at>? ORDER BY created_at DESC,id")
      .all(proposal.id, proposal.payloadHash, now) as {
      id: string;
      actor_id: string;
      status: string;
      expires_at: string;
      created_at: string;
      issuer_membership_id: string | null;
      governance_policy_version: string | null;
      reauthenticated_session_id: string | null;
      reauthenticated_at: string | null;
    }[];
    const accepted: EligibleHumanApproval[] = [];
    const actors = new Set<string>();
    for (const row of rows) {
      if (row.actor_id === proposal.actorId || actors.has(row.actor_id) || !row.issuer_membership_id ||
          row.governance_policy_version !== proposal.governancePolicyVersion ||
          !row.reauthenticated_session_id || !row.reauthenticated_at) continue;
      const membership = this.governance.getCurrentMembership({
        spaceId: proposal.spaceId,
        actorId: row.actor_id,
        now,
      });
      if (membership?.id !== row.issuer_membership_id) continue;
      const auth: HumanControlContext = {
        method: 'human-session',
        actorId: row.actor_id,
        sessionId: row.reauthenticated_session_id,
        reauthenticatedAt: row.reauthenticated_at,
      };
      const historical: LiquidityActor = {
        actorId: row.actor_id,
        budgetId: proposal.budgetId,
        spaceId: proposal.spaceId,
        membershipId: row.issuer_membership_id,
        governancePolicyVersion: row.governance_policy_version,
        now: row.created_at,
        auth,
      };
      const current = { ...historical, now };
      try {
        this.authorizeCompletion(historical, proposal.payload, 'approval');
        this.authorizeCompletion(current, proposal.payload, 'approval', false, 'read');
        this.completionSession(current, proposal.payload, now, true);
        actors.add(row.actor_id);
        accepted.push({
          id: row.id,
          approval: {
            actorId: row.actor_id,
            issuedAt: row.created_at,
            expiresAt: row.expires_at,
          },
        });
      } catch {
        // A stored approval is current only while its exact member and grants remain current.
      }
    }
    return accepted;
  }
  private governanceRequiredApprovers(
    actorId: string,
    spaceId: string,
    budgetId: string,
    operation: string,
    operations: readonly GovernanceOperation[],
    resources: readonly ResourceRef[],
    now: string,
  ): number {
    const policy = this.governance.getPolicy({ spaceId });
    if (!policy) throw new Error('Governance policy unavailable');
    const required = [
      { capability: 'approval', resourceKind: 'budget' as const, resourceId: budgetId },
      ...resources.map((resource) => ({ ...resource, capability: 'approval' })),
    ];
    return this.governance.authorize({
      actorId,
      spaceId,
      expectedPolicyVersion: policy.version,
      phase: 'read',
      operation,
      required,
      payload: { operations, resources },
      now,
    }).requiredApprovers;
  }
  private humanApprovalProvenance(input: LiquidityActor): {
    spaceId: string;
    membershipId: string;
    governancePolicyVersion: string;
    reauthenticatedSessionId: string;
    reauthenticatedAt: string;
  } {
    const context = this.currentMemberContext(input);
    const auth = input.auth;
    if (!context || !auth || auth.method !== 'human-session' || auth.actorId !== input.actorId)
      throw new Error('Human approval provenance unavailable');
    return {
      spaceId: context.spaceId,
      membershipId: context.membershipId,
      governancePolicyVersion: context.governancePolicyVersion,
      reauthenticatedSessionId: auth.sessionId,
      reauthenticatedAt: auth.reauthenticatedAt,
    };
  }
  private completionRequiredApprovals(proposal: SessionCompletionProposal, now: string): number {
    const count = this.currentPolicy(proposal.budgetId).approvalPolicy.minimumApprovers;
    if (!Number.isInteger(count) || count < 1) throw new Error('Invalid approval policy');
    if (!proposal.spaceId) throw new Error('Governance policy unavailable');
    return Math.max(count, this.governanceRequiredApprovers(
      proposal.actorId,
      proposal.spaceId,
      proposal.budgetId,
      'session_completion',
      completionOperations(proposal.payload),
      completionResourceRefs(proposal.payload),
      now,
    ));
  }
  private completionView(
    input: LiquidityActor & { proposalId: string; now?: string },
  ): SessionCompletionProposalView {
    const proposal = this.loadCompletion(input.proposalId);
    if (proposal.budgetId !== input.budgetId) throw new Error('Resource authorization denied');
    if (['proposed', 'approved'].includes(proposal.state.phase) &&
        !this.proposalOrigin(proposal.id, input.now ?? new Date().toISOString()))
      throw new Error('Pending proposal provenance is no longer current');
    this.authorizeCompletion(input, proposal.payload, 'proposal');
    this.completionSession(input, proposal.payload, input.now ?? proposal.createdAt, true, false, true);
    const all = this.db
      .prepare(
        'SELECT id,status,expires_at FROM proposal_approvals WHERE proposal_id=? AND payload_hash=? ORDER BY created_at DESC,id',
      )
      .all(proposal.id, proposal.payloadHash) as {
      id: string;
      status: string;
      expires_at: string;
    }[];
    const now = input.now ?? proposal.createdAt;
    const active = this.completionApprovals(proposal, now);
    const latest = all[0];
    const approvalStatus =
      active.length > 0
        ? 'active'
        : latest && ['consumed', 'expired', 'superseded'].includes(latest.status)
          ? (latest.status as 'consumed' | 'expired' | 'superseded')
          : 'none';
    const evidence = this.db
      .prepare(
        'SELECT evidence_id,evidence_kind,parent_id,account_id,transaction_id FROM session_completion_evidence WHERE budget_id=? AND proposal_id=? ORDER BY rowid DESC LIMIT 1',
      )
      .get(proposal.budgetId, proposal.id) as
      | {
          evidence_id: string;
          evidence_kind: string;
          parent_id: string;
          account_id: string;
          transaction_id: string | null;
        }
      | undefined;
    const reconciliation: SessionCompletionReconciliation | null = evidence
      ? {
          evidenceId: evidence.evidence_id,
          kind: evidence.evidence_kind as SessionCompletionReconciliation['kind'],
          parentId: evidence.parent_id,
          accountId: evidence.account_id,
          transactionId: evidence.transaction_id ?? undefined,
          verified: evidence.evidence_kind === 'manual_parent' ||
            evidence.evidence_kind === 'imported_link',
        }
      : null;
    return {
      ...proposal,
      approvalId: active[0]?.id ?? null,
      approvalCount: active.length,
      requiredApprovals: this.completionRequiredApprovals(proposal, now),
      approvers: currentHumanApprovers(active),
      approvalStatus,
      manualTransactionId: proposal.state.phase === 'verified'
        ? proposal.payload.manualInput.parentId
        : null,
      importedTransactionId:
        evidence?.evidence_kind === 'imported_link' ? evidence.transaction_id : null,
      reconciliation,
    };
  }
  private updateCompletion(
    proposal: SessionCompletionProposal,
    state: SessionCompletionState,
    now: string,
  ): SessionCompletionProposal {
    const changed = this.db
      .prepare(
        "UPDATE action_proposals SET state=?,version=version+1,superseded_at=CASE WHEN ?='superseded' THEN ? ELSE superseded_at END WHERE id=? AND version=?",
      )
      .run(JSON.stringify(state), state.outcome, now, proposal.id, proposal.version);
    if (changed.changes !== 1) throw new Error('Proposal version conflict');
    return this.loadCompletion(proposal.id);
  }
  private completionClaim(proposal: SessionCompletionProposal): LiquidityClaimBundle {
    const row = this.db
      .prepare(
        "SELECT bundle FROM liquidity_claims WHERE budget_id=? AND owner_kind='session_completion' AND owner_id=?",
      )
      .get(proposal.budgetId, proposal.id) as { bundle: string } | undefined;
    if (!row) throw new Error('Completion claim missing');
    return JSON.parse(row.bundle) as LiquidityClaimBundle;
  }
  private changeCompletionClaim(
    proposal: SessionCompletionProposal,
    state: LiquidityClaimBundle['state'],
  ): void {
    const bundle = this.completionClaim(proposal);
    if (bundle.state === state) return;
    this.persistClaim(proposal.budgetId, 'session_completion', proposal.id, {
      ...bundle,
      state,
      initiated: state === 'initiated' || bundle.initiated,
    });
  }
  /** Converts only exact originating holds after a trusted manual parent is verified. */
  private consumeCompletionProspectiveClaims(
    proposal: SessionCompletionProposal,
    parentEvidenceId: string,
    now: string,
  ): void {
    const rows = this.db
      .prepare(
        "SELECT m.claim_id,m.claim,c.bundle FROM liquidity_claim_metadata m JOIN liquidity_claims c ON c.budget_id=m.budget_id AND c.id=m.claim_id WHERE m.budget_id=? AND m.actor_id=? AND m.source_id=? AND m.lifecycle_state='active'",
      )
      .all(proposal.budgetId, proposal.actorId,
        `session:${proposal.payload.sessionId}:${proposal.payload.sessionVersion}`) as {
      claim_id: string; claim: string; bundle: string;
    }[];
    for (const row of rows) {
      const claim = JSON.parse(row.claim) as ProspectiveClaim;
      const bundle = JSON.parse(row.bundle) as LiquidityClaimBundle;
      if (bundle.state !== 'active' || bundle.initiated) continue;
      const scope = claim.scope;
      const matches = scope.kind === 'category'
        ? proposal.payload.categoryCharges.some((charge) =>
            charge.categoryId === scope.id &&
            completionMoneyEquals(charge.amount, claim.amount))
        : scope.kind === 'account' &&
          scope.id === proposal.payload.manualInput.accountId &&
          claim.amount.minorUnits === String(-proposal.payload.manualInput.amount) &&
          claim.amount.currency === proposal.payload.categoryCharges[0]?.amount.currency;
      if (!matches) continue;
      const evidenceId = `${parentEvidenceId}:claim:${row.claim_id}`;
      this.persistClaim(proposal.budgetId, 'prospective', row.claim_id, {
        ...bundle, state: 'settled',
      });
      this.db
        .prepare(
          "UPDATE liquidity_claim_metadata SET lifecycle_state='consumed',updated_at=?,consumption_evidence_id=? WHERE budget_id=? AND claim_id=? AND lifecycle_state='active'",
        )
        .run(now, evidenceId, proposal.budgetId, row.claim_id);
      this.audit(
        { actorId: proposal.actorId, budgetId: proposal.budgetId },
        'prospective_claim:consume_from_completion', row.claim_id, now, null,
      );
    }
  }

  private closeCompletion(
    proposal: SessionCompletionProposal,
    outcome: 'cancelled' | 'expired' | 'superseded',
    now: string,
  ): SessionCompletionProposal {
    this.db
      .prepare(
        "UPDATE proposal_approvals SET status='superseded',superseded_at=? WHERE proposal_id=? AND status='active'",
      )
      .run(now, proposal.id);
    if (proposal.state.phase === 'write_intent')
      return this.updateCompletion(proposal, { ...proposal.state, outcome }, now);
    this.changeCompletionClaim(
      proposal,
      outcome === 'expired' ? 'expired' : 'cancelled',
    );
    return this.updateCompletion(proposal, completionState('closed', outcome), now);
  }
  private invalidateCompletionProposals(budgetId: string, now: string, sessionId?: string): void {
    const rows = this.db
      .prepare("SELECT * FROM action_proposals WHERE budget_id=? AND operation='session_completion'")
      .all(budgetId);
    for (const row of rows) {
      const proposal = this.mapProposal(row) as SessionCompletionProposal;
      if (
        ['proposed', 'approved'].includes(proposal.state.phase) &&
        (!sessionId || proposal.payload.sessionId === sessionId)
      )
        this.closeCompletion(proposal, 'superseded', now);
    }
  }
  private scopedTransferIntent(input: LiquidityActor & { proposalId: string }): TransferProposal {
    if (!this.spaceContext(input)) throw new Error('Resource authorization denied');
    const proposal = this.load(input.proposalId);
    if (proposal.budgetId !== input.budgetId) throw new Error('Resource authorization denied');
    if (!['initiated', 'confirmed', 'closed'].includes(proposal.state.phase) &&
        !this.proposalOrigin(proposal.id, input.now ?? new Date().toISOString()))
      throw new Error('Pending proposal provenance is no longer current');
    return proposal;
  }
  /** Returns a server-owned intent for an exact authorized operation or conclusion; project independent private reads before disclosure. */
  getTransferProposalIntent(input: LiquidityActor & {
    proposalId: string;
    capability: 'proposal' | 'approval' | 'initiation-report' | 'confirmation' | 'conclusion';
  }): TransferProposal {
    const proposal = this.scopedTransferIntent(input);
    this.authorizePlan(
      input,
      proposal.payload.plan,
      input.capability,
      false,
      input.capability === 'proposal' ? 'propose' : 'read',
      input.capability === 'conclusion',
    );
    return proposal;
  }
  /** Lists exact authorized server-owned intents; raw financial fields are not a public read projection. */
  listTransferProposalIntents(input: LiquidityActor & {
    capability: 'proposal' | 'approval' | 'initiation-report' | 'confirmation' | 'conclusion';
  }): TransferProposal[] {
    this.requireResource({
      ...input,
      resourceKind: 'budget',
      resourceId: input.budgetId,
      capability: input.capability,
      operation: 'transfer',
      phase: input.capability === 'proposal' ? 'propose' : 'read',
      ...(input.capability === 'conclusion' ? { visibility: 'aggregate' as const } : {}),
    });
    const rows = this.db.prepare(
      "SELECT id FROM action_proposals WHERE budget_id=? AND operation='transfer' ORDER BY created_at DESC,id",
    ).all(input.budgetId) as { id: string }[];
    return rows.flatMap(({ id }) => {
      try { return [this.getTransferProposalIntent({ ...input, proposalId: id })]; }
      catch { return []; }
    });
  }
  getTransferProposal(input: LiquidityActor & { proposalId: string }): TransferProposal {
    this.budget(input, 'liquidity');
    const p = this.scopedTransferIntent(input);
    this.authorizePlan(input, p.payload.plan, 'liquidity', false, 'read');
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
    this.budget(input, 'liquidity');
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
  /** Replays a client creation intent before another native evaluation can see its own held claim. */
  replaySessionCompletion(
    input: CompletionCreationIntent & { now: string },
  ): SessionCompletionProposalView | null {
    this.budget(input, 'proposal');
    time(input.now);
    const replay = this.replay<SessionCompletionProposalView>(
      input, 'session_completion:admit', completionCreationRequest(input),
    );
    return replay ? this.completionView({ ...input, proposalId: replay.id }) : null;
  }

  /** The trusted service stores the original native plan; callers receive an allowlisted projection. */
  admitSessionCompletion(
    input: AdmitSessionCompletionInput,
    validator: ClaimValidator,
  ): SessionCompletionProposalView {
    validateCompletionPayload(input.payload, input.now);
    if (input.payloadHash !== completionPayloadHash(input.payload))
      throw new Error('Payload hash mismatch');
    this.authorizeCompletion(input, input.payload, 'proposal');
    return this.db
      .transaction(() => {
        this.authorizeCompletion(input, input.payload, 'proposal');
        const replay = this.replay<SessionCompletionProposalView>(
          input, 'session_completion:admit',
          completionCreationRequest({
            ...input, payeeName: input.payload.manualInput.payeeName,
            notes: input.payload.manualInput.notes,
          }),
        );
        if (replay)
          return this.completionView({
            actorId: input.actorId,
            budgetId: input.budgetId,
            proposalId: replay.id,
            now: input.now,
          });
        const policy = this.currentPolicy(input.budgetId);
        future(policy.policy.expiresAt, input.now);
        validateCompletionCooldown(input.payload, policy, input.now, true);
        const session = this.completionSession(input, input.payload, input.now, false, true);
        if (session.version !== input.expectedSessionVersion)
          throw new Error('Session version conflict');
        if (input.payload.sessionVersion !== input.expectedSessionVersion)
          throw new Error('Session version conflict');
        validateCompletionClaim(input.payload, input.claim, policy, session, input.now);
        const active = (
          this.db
            .prepare(
              "SELECT * FROM action_proposals WHERE budget_id=? AND operation='session_completion'",
            )
            .all(input.budgetId) as unknown[]
        )
          .map((row) => this.mapProposal(row) as SessionCompletionProposal)
          .find(
            (proposal) =>
              proposal.payload.sessionId === input.sessionId &&
              proposal.state.phase !== 'closed',
          );
        if (active)
          throw new Error(active.state.phase === 'verified'
            ? 'Session already completed'
            : 'Active session completion already exists');
        const existingClaim = this.db
          .prepare('SELECT 1 FROM liquidity_claims WHERE budget_id=? AND id=?')
          .get(input.budgetId, input.claim.id);
        if (existingClaim) throw new Error('Claim ID already exists');
        for (const effect of input.claim.effects)
          this.assertNoDuplicateEconomicEffect(input.budgetId, effect);
        const id = randomUUID();
        const expiresAt = [
          policy.policy.expiresAt,
          session.expiresAt,
          input.claim.expiresAt,
        ].sort((left, right) => Date.parse(left) - Date.parse(right))[0]!;
        const payload = structuredClone(input.payload);
        const context = this.currentMemberContext(input);
        if (!context) throw new Error('Current human membership unavailable');
        const governancePolicyVersion = this.currentPolicy(input.budgetId).governancePolicyVersion;
        if (!governancePolicyVersion) throw new Error('Governance policy unavailable');
        this.db
          .prepare(
            "INSERT INTO action_proposals (id,operation,budget_id,payload_hash,policy_version,preconditions,expires_at,actor_id,provenance,provider_model,correlation_id,superseded_at,created_at,payload,version,state,space_id,requester_membership_id,governance_policy_version) VALUES (?,'session_completion',?,?,?,?,?,?,'human',NULL,?,NULL,?,?,1,?,?,?,?)",
          )
          .run(
            id,
            input.budgetId,
            input.payloadHash,
            policy.policy.version,
            JSON.stringify({
              sessionId: input.sessionId,
              sessionVersion: input.expectedSessionVersion,
              materialHash: input.payload.materialHash,
            }),
            expiresAt,
            input.actorId,
            input.payload.manualInput.correlationId,
            input.now,
            JSON.stringify(payload),
            JSON.stringify(completionState()),
            context.spaceId,
            context.membershipId,
            governancePolicyVersion,
          );
        this.validate(
          input,
          input.expectedClaimSetRevision,
          validator,
          null,
          session,
          input.claim,
        );
        const proposal = this.loadCompletion(id);
        this.persistClaim(input.budgetId, 'session_completion', id, {
          ...structuredClone(input.claim),
          id: input.claim.id,
        });
        const result = this.completionView({
          actorId: input.actorId,
          budgetId: input.budgetId,
          proposalId: proposal.id,
          now: input.now,
        });
        this.record(input, 'session_completion:admit', id, completionCreationRequest({
          ...input, payeeName: input.payload.manualInput.payeeName,
          notes: input.payload.manualInput.notes,
        }), result);
        return result;
      })
      .immediate();
  }
  approveSessionCompletion(
    input: ApproveSessionCompletionInput,
    validator: ClaimValidator,
  ): SessionCompletionProposalView {
    const outcome = this.db
      .transaction(() => {
        const { proposal, session } = this.completionCommand(input, 'approval');
        const replay = this.replay<SessionCompletionProposalView>(
          input,
          'session_completion:approve',
          input,
        );
        if (replay)
          return this.completionView({
            actorId: input.actorId,
            budgetId: input.budgetId,
            proposalId: replay.id,
            now: input.now,
          });
        if (proposal.version !== input.expectedVersion)
          throw new Error('Proposal version conflict');
        future(proposal.expiresAt, input.now);
        if (!['proposed', 'approved'].includes(proposal.state.phase))
          throw new Error('Invalid approval phase');
        const policy = this.currentPolicy(input.budgetId);
        if (proposal.policyVersion !== policy.policy.version) throw new Error('Policy changed');
        validateCompletionCooldown(proposal.payload, policy, input.now, false);
        try {
          this.validate(
            input,
            input.expectedClaimSetRevision,
            validator,
            null,
            session,
            null,
            this.completionClaim(proposal).id,
          );
        } catch (error) {
          this.closeCompletion(proposal, 'superseded', input.now);
          return {
            staleError: error instanceof Error ? error.message : 'Completion validation failed',
          };
        }
        const proof = this.humanApprovalProvenance(input);
        this.db
          .prepare(
            "INSERT INTO proposal_approvals (id,proposal_id,payload_hash,actor_id,status,expires_at,consumed_at,superseded_at,created_at,proposal_version,issuer_membership_id,governance_policy_version,reauthenticated_session_id,reauthenticated_at) VALUES (?,?,?,?,'active',?,NULL,NULL,?,?,?,?,?,?)",
          )
          .run(
            randomUUID(),
            proposal.id,
            proposal.payloadHash,
            input.actorId,
            proposal.expiresAt,
            input.now,
            proposal.version,
            proof.membershipId,
            proof.governancePolicyVersion,
            proof.reauthenticatedSessionId,
            proof.reauthenticatedAt,
          );
        const phase =
          this.completionApprovals(proposal, input.now).length >=
          this.completionRequiredApprovals(proposal, input.now)
            ? 'approved'
            : 'proposed';
        const updated = this.updateCompletion(proposal, completionState(phase), input.now);
        const result = this.completionView({
          actorId: input.actorId,
          budgetId: input.budgetId,
          proposalId: updated.id,
          now: input.now,
        });
        this.record(input, 'session_completion:approve', updated.id, input, result);
        return result;
      })
      .immediate();
    if (outcome && 'staleError' in outcome) throw new Error(outcome.staleError);
    return outcome;
  }
  beginSessionCompletionWrite(
    input: BeginSessionCompletionWriteInput,
    validator: ClaimValidator,
  ): SessionCompletionWriteIntentResult {
    const outcome = this.db
      .transaction(() => {
        const candidate = this.loadCompletion(input.proposalId);
        if (candidate.budgetId !== input.budgetId) throw new Error('Resource authorization denied');
        if (!['approved', 'write_intent', 'verified', 'review_required'].includes(candidate.state.phase))
          throw new Error('Current approval required');
        if (this.completionApprovals(candidate, input.now, true).length <
            this.completionRequiredApprovals(candidate, input.now))
          throw new Error('Current authorized approvals required');
        const { proposal, session } = this.completionCommand(input, 'initiation-report', true);
        this.authorizeCompletion(input, proposal.payload, 'confirmation', true);
        const replay = this.replay<SessionCompletionWriteIntentResult>(
          input,
          'session_completion:begin_write',
          input,
        );
        if (replay) {
          return {
            proposal: this.completionView({
              actorId: input.actorId,
              budgetId: input.budgetId,
              proposalId: replay.proposal.id,
              now: input.now,
            }),
            payload: null,
            acquiredWriteIntent: false,
          };
        }
        if (['write_intent', 'verified', 'review_required'].includes(proposal.state.phase))
          return {
            proposal: this.completionView({
              actorId: input.actorId,
              budgetId: input.budgetId,
              proposalId: proposal.id,
              now: input.now,
            }),
            payload: null,
            acquiredWriteIntent: false,
          };
        if (proposal.version !== input.expectedVersion)
          throw new Error('Proposal version conflict');
        if (proposal.state.phase !== 'approved') throw new Error('Current approval required');
        future(proposal.expiresAt, input.now);
        const policy = this.currentPolicy(input.budgetId);
        if (proposal.policyVersion !== policy.policy.version) throw new Error('Policy changed');
        validateCompletionCooldown(proposal.payload, policy, input.now, false);
        if (
          this.completionApprovals(proposal, input.now).length <
          this.completionRequiredApprovals(proposal, input.now)
        )
          throw new Error('Current authorized approvals required');
        try {
          this.validate(
            input,
            input.expectedClaimSetRevision,
            validator,
            null,
            session,
            null,
            this.completionClaim(proposal).id,
          );
        } catch (error) {
          this.closeCompletion(proposal, 'superseded', input.now);
          return {
            staleError: error instanceof Error ? error.message : 'Completion validation failed',
          };
        }
        const intentId = randomUUID();
        this.db
          .prepare(
            'INSERT INTO session_completion_writes (budget_id,proposal_id,intent_id,payload_hash,parent_id,correlation_id,status,result,evidence_id,initiated_at,finished_at) VALUES (?,?,?,?,?,?,\'write_intent\',NULL,NULL,?,NULL)',
          )
          .run(
            input.budgetId,
            proposal.id,
            intentId,
            proposal.payloadHash,
            proposal.payload.manualInput.parentId,
            proposal.payload.manualInput.correlationId,
            input.now,
          );
        for (const approval of this.completionApprovals(proposal, input.now))
          this.db
            .prepare(
              "UPDATE proposal_approvals SET status='consumed',consumed_at=? WHERE id=? AND status='active'",
            )
            .run(input.now, approval.id);
        this.changeCompletionClaim(proposal, 'initiated');
        const updated = this.updateCompletion(
          proposal,
          completionState('write_intent'),
          input.now,
        );
        const result: SessionCompletionWriteIntentResult = {
          proposal: this.completionView({
            actorId: input.actorId,
            budgetId: input.budgetId,
            proposalId: updated.id,
            now: input.now,
          }),
          payload: structuredClone(proposal.payload),
          acquiredWriteIntent: true,
        };
        this.record(input, 'session_completion:begin_write', updated.id, input, result);
        return result;
      })
      .immediate();
    if (outcome && 'staleError' in outcome) throw new Error(outcome.staleError);
    return outcome;
  }
  finishSessionCompletionWrite(
    input: FinishSessionCompletionWriteInput,
  ): SessionCompletionProposalView {
    return this.db
      .transaction(() => {
        const proposal = this.loadCompletion(input.proposalId);
        if (proposal.budgetId !== input.budgetId)
          throw new Error('Resource authorization denied');
        if (proposal.payloadHash !== input.payloadHash)
          throw new Error('Payload hash mismatch');
        validateCompletionPayload(proposal.payload, input.now);
        this.requireHumanReconciliation(input);
        this.authorizeCompletion(input, proposal.payload, 'confirmation', false, 'read');
        this.completionSession(input, proposal.payload, input.now, true, false, true);
        const replay = this.replay<SessionCompletionProposalView>(
          input,
          'session_completion:finish_write',
          input,
        );
        if (replay)
          return this.completionView({
            actorId: input.actorId,
            budgetId: input.budgetId,
            proposalId: replay.id,
            now: input.now,
          });
        if (proposal.version !== input.expectedVersion)
          throw new Error('Proposal version conflict');
        if (proposal.state.phase !== 'write_intent')
          throw new Error('Write intent unavailable');
        const write = this.db
          .prepare(
            'SELECT status,intent_id,parent_id,correlation_id FROM session_completion_writes WHERE budget_id=? AND proposal_id=? AND payload_hash=?',
          )
          .get(input.budgetId, proposal.id, proposal.payloadHash) as
          | { status: string; intent_id: string; parent_id: string; correlation_id: string }
          | undefined;
        if (
          !write ||
          write.status !== 'write_intent' ||
          !write.intent_id.trim() ||
          write.parent_id !== proposal.payload.manualInput.parentId ||
          write.correlation_id !== proposal.payload.manualInput.correlationId
        )
          throw new Error('Write intent unavailable');
        const result = input.result;
        if (
          result.parentId !== proposal.payload.manualInput.parentId ||
          (result.success && (!result.verified || result.transactionId !== result.parentId)) ||
          (result.verified && !result.success)
        )
          throw new Error('Invalid completion parent transaction identity');
        let state: SessionCompletionState;
        if (result.success && result.verified) {
          const evidenceId = `manual:${proposal.payload.manualInput.accountId}:${result.parentId}`;
          if (result.evidenceId && result.evidenceId !== evidenceId)
            throw new Error('Invalid completion evidence identity');
          this.db
            .prepare(
              'INSERT INTO session_completion_evidence (budget_id,evidence_id,proposal_id,payload_hash,evidence_kind,parent_id,account_id,transaction_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
            )
            .run(
              input.budgetId,
              evidenceId,
              proposal.id,
              proposal.payloadHash,
              'manual_parent',
              result.parentId,
              proposal.payload.manualInput.accountId,
              result.transactionId ?? result.parentId,
              input.now,
            );
          this.changeCompletionClaim(proposal, 'settled');
          this.consumeCompletionProspectiveClaims(proposal, evidenceId, input.now);
          state = completionState('verified');
          this.db
            .prepare(
              "UPDATE session_completion_writes SET status='verified',result=?,evidence_id=?,finished_at=? WHERE budget_id=? AND proposal_id=?",
            )
            .run(JSON.stringify(result), evidenceId, input.now, input.budgetId, proposal.id);
        } else if (!result.success && result.reviewRequired === true &&
          (result.code === 'IMPORTED_CANDIDATE_REVIEW' ||
            result.code === 'AMBIGUOUS_IMPORTED_CANDIDATE')) {
          // These connector codes are returned before addTransactions: no manual write was attempted.
          this.persistClaim(input.budgetId, 'session_completion', proposal.id, {
            ...this.completionClaim(proposal), state: 'cancelled', initiated: false,
          });
          this.db
            .prepare(
              "UPDATE proposal_approvals SET status='superseded',superseded_at=? WHERE proposal_id=? AND status='active'",
            )
            .run(input.now, proposal.id);
          state = completionState('closed', 'reconciliation_required');
          this.db
            .prepare(
              "UPDATE session_completion_writes SET status='review_required',result=?,finished_at=? WHERE budget_id=? AND proposal_id=?",
            )
            .run(JSON.stringify(result), input.now, input.budgetId, proposal.id);
        } else {
          state = completionState('review_required', 'reconciliation_required');
          this.db
            .prepare(
              "UPDATE session_completion_writes SET status='review_required',result=?,finished_at=? WHERE budget_id=? AND proposal_id=?",
            )
            .run(JSON.stringify(result), input.now, input.budgetId, proposal.id);
        }
        const updated = this.updateCompletion(proposal, state, input.now);
        const view = this.completionView({
          actorId: input.actorId,
          budgetId: input.budgetId,
          proposalId: updated.id,
          now: input.now,
        });
        this.record(input, 'session_completion:finish_write', updated.id, input, view);
        return view;
      })
      .immediate();
  }
  getSessionCompletionProposal(
    input: LiquidityActor & { proposalId: string; now?: string },
  ): SessionCompletionProposalView {
    return this.completionView(input);
  }
  listSessionCompletionProposals(
    input: LiquidityActor & { now?: string; sessionId?: string },
  ): SessionCompletionProposalView[] {
    this.budget(input, 'proposal');
    const rows = this.db
      .prepare(
        "SELECT id FROM action_proposals WHERE budget_id=? AND operation='session_completion' ORDER BY created_at DESC,id",
      )
      .all(input.budgetId) as { id: string }[];
    return rows.flatMap(({ id }) => {
      try {
        const view = this.completionView({ ...input, proposalId: id });
        return !input.sessionId || view.payload.sessionId === input.sessionId ? [view] : [];
      } catch {
        return [];
      }
    });
  }
  reconcileSessionCompletion(
    input: ReconcileSessionCompletionInput,
  ): SessionCompletionProposalView {
    return this.db
      .transaction(() => {
        const proposal = this.loadCompletion(input.proposalId);
        if (proposal.budgetId !== input.budgetId)
          throw new Error('Resource authorization denied');
        if (proposal.payloadHash !== input.payloadHash)
          throw new Error('Payload hash mismatch');
        validateCompletionPayload(proposal.payload, input.now);
        this.requireHumanReconciliation(input);
        this.authorizeCompletion(input, proposal.payload, 'confirmation', false, 'read');
        this.completionSession(input, proposal.payload, input.now, true, false, true);
        const write = this.db
          .prepare(
            'SELECT status,intent_id,payload_hash,parent_id,correlation_id FROM session_completion_writes WHERE budget_id=? AND proposal_id=?',
          )
          .get(input.budgetId, proposal.id) as
          | {
              status: string;
              intent_id: string;
              payload_hash: string;
              parent_id: string;
              correlation_id: string;
            }
          | undefined;
        if (
          !write ||
          !write.intent_id.trim() ||
          write.payload_hash !== proposal.payloadHash ||
          write.parent_id !== proposal.payload.manualInput.parentId ||
          write.correlation_id !== proposal.payload.manualInput.correlationId ||
          !['write_intent', 'review_required', 'verified'].includes(write.status)
        )
          throw new Error('Completion write intent unavailable');
        const replay = this.replay<SessionCompletionProposalView>(
          input,
          'session_completion:reconcile',
          input,
        );
        if (replay)
          return this.completionView({
            actorId: input.actorId,
            budgetId: input.budgetId,
            proposalId: replay.id,
            now: input.now,
          });
        if (proposal.version !== input.expectedVersion)
          throw new Error('Proposal version conflict');
        const laterImport =
          proposal.state.phase === 'verified' && input.evidence.kind === 'imported_link';
        const awaitingEvidence = ['write_intent', 'review_required'].includes(proposal.state.phase);
        if (!laterImport && !awaitingEvidence)
          throw new Error('Completion does not require reconciliation');
        if (
          (proposal.state.phase === 'write_intent' && write.status !== 'write_intent') ||
          (proposal.state.phase === 'review_required' &&
            !['write_intent', 'review_required'].includes(write.status)) ||
          (laterImport && write.status !== 'verified')
        )
          throw new Error('Completion write intent unavailable');
        if (awaitingEvidence) {
          const hold = this.completionClaim(proposal);
          if (hold.state !== 'initiated' || !hold.initiated)
            throw new Error('Initiated completion hold unavailable');
        }
        if (input.evidence.parentId !== proposal.payload.manualInput.parentId)
          throw new Error('Reconciliation parent mismatch');
        if (input.evidence.accountId !== proposal.payload.manualInput.accountId)
          throw new Error('Reconciliation account mismatch');
        if (!input.evidence.evidenceId.trim()) throw new Error('Reconciliation evidence required');
        if (input.evidence.kind === 'imported_link') {
          if (
            !laterImport ||
            input.evidence.verified !== true ||
            input.evidence.transactionId !== input.evidence.parentId ||
            !input.evidence.evidenceId.startsWith(`import:${input.evidence.accountId}:`) ||
            input.evidence.evidenceId === `import:${input.evidence.accountId}:` ||
            !this.db.prepare(
              "SELECT 1 FROM session_completion_evidence WHERE budget_id=? AND proposal_id=? AND evidence_kind='manual_parent' AND parent_id=? AND account_id=?",
            ).get(input.budgetId, proposal.id, input.evidence.parentId, input.evidence.accountId) ||
            this.db.prepare(
              "SELECT 1 FROM session_completion_evidence WHERE budget_id=? AND proposal_id=? AND evidence_kind='imported_link'",
            ).get(input.budgetId, proposal.id)
          )
            throw new Error('Imported reconciliation link requires verified manual parent evidence');
        } else if (input.evidence.kind === 'manual_parent') {
          if (
            input.evidence.verified !== true ||
            input.evidence.transactionId !== input.evidence.parentId ||
            input.evidence.evidenceId !==
              `manual:${input.evidence.accountId}:${input.evidence.parentId}`
          )
            throw new Error('Verified exact manual parent evidence required');
        } else if (input.evidence.kind === 'ambiguous' && input.evidence.verified === true) {
          throw new Error('Ambiguous reconciliation evidence cannot be verified');
        }
        if (!['manual_parent', 'imported_link', 'ambiguous'].includes(input.evidence.kind))
          throw new Error('Invalid reconciliation evidence kind');
        if (this.db.prepare(
          'SELECT 1 FROM session_completion_evidence WHERE budget_id=? AND evidence_id=?',
        ).get(input.budgetId, input.evidence.evidenceId))
          throw new Error('Reconciliation evidence already used');
        this.db
          .prepare(
            'INSERT INTO session_completion_evidence (budget_id,evidence_id,proposal_id,payload_hash,evidence_kind,parent_id,account_id,transaction_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
          )
          .run(
            input.budgetId,
            input.evidence.evidenceId,
            proposal.id,
            proposal.payloadHash,
            input.evidence.kind,
            input.evidence.parentId,
            input.evidence.accountId,
            input.evidence.transactionId ?? null,
            input.now,
          );
        const trusted =
          input.evidence.kind === 'manual_parent' && input.evidence.verified === true;
        if (trusted) {
          this.changeCompletionClaim(proposal, 'settled');
          this.consumeCompletionProspectiveClaims(proposal, input.evidence.evidenceId, input.now);
          this.db
            .prepare(
              "UPDATE session_completion_writes SET status='verified',result=?,evidence_id=?,finished_at=? WHERE budget_id=? AND proposal_id=?",
            )
            .run(
              JSON.stringify(input.evidence),
              input.evidence.evidenceId,
              input.now,
              input.budgetId,
              proposal.id,
            );
        }
        const updated = this.updateCompletion(
          proposal,
          laterImport || trusted
            ? completionState('verified')
            : completionState('review_required', 'ambiguous'),
          input.now,
        );
        const view = this.completionView({
          actorId: input.actorId,
          budgetId: input.budgetId,
          proposalId: updated.id,
          now: input.now,
        });
        this.record(input, 'session_completion:reconcile', updated.id, input, view);
        return view;
      })
      .immediate();
  }
  saveTransferPreview(input: SaveTransferPreviewInput): TransferPreview {
    return this.db
      .transaction(() => {
        this.budget(input, 'conclusion');
        const context = this.currentMemberContext(input);
        if (!context) throw new Error('Current human membership unavailable');
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
          spaceId: context.spaceId,
          membershipId: context.membershipId,
          plan: structuredClone(input.plan),
          createdAt: input.now,
          sessionId: session?.id ?? null,
          sessionVersion: session?.version ?? null,
        };
        this.db
          .prepare('INSERT INTO transfer_previews (id,budget_id,actor_id,record,space_id,membership_id) VALUES (?,?,?,?,?,?)')
          .run(id, input.budgetId, input.actorId, JSON.stringify(preview), context.spaceId, context.membershipId);
        return preview;
      })
      .immediate();
  }
  /** No expiry filter: only the trusted service may use an expired original for idempotency lookup. */
  getTransferPreview(input: LiquidityActor & { id: string }): TransferPreview | null {
    this.budget(input, 'conclusion');
    const row = this.db.prepare('SELECT * FROM transfer_previews WHERE id=?').get(input.id) as
      { budget_id: string; actor_id: string; record: string; space_id: string | null; membership_id: string | null } | undefined;
    if (!row) return null;
    const context = this.currentMemberContext(input);
    if (row.actor_id !== input.actorId || row.budget_id !== input.budgetId ||
        !context || row.space_id !== context.spaceId || row.membership_id !== context.membershipId)
      throw new Error('Preview authorization denied');
    return JSON.parse(row.record) as TransferPreview;
  }
  private currentPolicy(budgetId: string): LiquidityPolicyRecord {
    const row = this.db
      .prepare(
        'SELECT p.policy,p.actor_id,p.created_at FROM liquidity_policy_versions p JOIN liquidity_current_policy c ON c.budget_id=p.budget_id AND c.version=p.version WHERE p.budget_id=?',
      )
      .get(budgetId) as { policy: string; actor_id: string; created_at: string } | undefined;
    if (!row) throw new Error('Liquidity policy unavailable');
    const space = this.governance.getSpaceForBudget({ budgetId });
    const governancePolicy = space ? this.governance.getPolicy({ spaceId: space.id }) : null;
    return {
      budgetId,
      policy: JSON.parse(row.policy),
      approvalPolicy: governancePolicy
        ? {
            minimumApprovers: governancePolicy.minimumApprovers,
            thresholds: governancePolicy.approvalThresholds.map((threshold) => ({
              currency: threshold.currency,
              minimumMinorUnits: threshold.amountMinorUnits,
              minimumApprovers: threshold.requiredApprovers,
            })),
          }
        : { minimumApprovers: 1, thresholds: [] },
      governancePolicyVersion: governancePolicy?.version ?? null,
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
    if (input.auth.actorId !== input.actorId) throw new Error('Policy authorization denied');
    const context = this.spaceContext(input);
    if (!context?.membershipId) throw new Error('Current governed membership unavailable');
    const reservationMode = governedReservationMode(input.policy);
    const governedPolicy = { ...input.policy, reservationMode };
    future(governedPolicy.expiresAt, input.now);
    const currentGovernancePolicy = this.governance.getPolicy({ spaceId: context.spaceId });
    const thresholds = input.approvalPolicy.thresholds === undefined
      ? currentGovernancePolicy?.approvalThresholds.map((threshold) => ({
          currency: threshold.currency,
          minimumMinorUnits: threshold.amountMinorUnits,
          minimumApprovers: threshold.requiredApprovers,
        })) ?? []
      : input.approvalPolicy.thresholds;
    const operationApprovers = currentGovernancePolicy?.operationApprovers ?? {};
    return this.db
      .transaction(() => {
        const current = this.db
          .prepare('SELECT version FROM liquidity_current_policy WHERE budget_id=?')
          .get(input.budgetId) as { version: string } | undefined;
        if ((current?.version ?? null) !== input.expectedVersion)
          throw new Error('Financial policy version conflict');
        this.governance.setPolicy({
          spaceId: context.spaceId,
          expectedVersion: input.expectedGovernancePolicyVersion,
          policy: {
            minimumApprovers: input.approvalPolicy.minimumApprovers,
            approvalThresholds: thresholds.map((threshold) => ({
              currency: threshold.currency,
              amountMinorUnits: threshold.minimumMinorUnits,
              requiredApprovers: threshold.minimumApprovers,
            })),
            operationApprovers,
          },
          now: input.now,
          auth: input.auth,
        });
        this.db
          .prepare('INSERT INTO liquidity_policy_versions VALUES (?,?,?,?,?,?)')
          .run(
            input.budgetId,
            governedPolicy.version,
            JSON.stringify(governedPolicy),
            '{}',
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
            'SELECT c.id,c.bundle,c.owner_kind,c.owner_id,m.actor_id,m.mode,m.policy_version,m.claim,m.updated_at FROM liquidity_claims c LEFT JOIN liquidity_claim_metadata m ON m.budget_id=c.budget_id AND m.claim_id=c.id WHERE c.budget_id=? ORDER BY c.id',
          )
          .all(budgetId) as {
          id: string;
          bundle: string;
          owner_kind: string;
          owner_id: string;
          actor_id: string | null;
          mode: ProspectiveClaimMode | null;
          policy_version: string | null;
          claim: string | null;
          updated_at: string | null;
        }[];
        const covered = new Map<string, LiquidityClaimBundle['effects']>();
        for (const row of rows) {
          if (row.owner_kind !== 'session_completion') continue;
          const bundle = JSON.parse(row.bundle) as LiquidityClaimBundle;
          if (bundle.state !== 'active' && bundle.state !== 'initiated') continue;
          if (!bundle.initiated && Date.parse(bundle.expiresAt) <= nowTime) continue;
          const source = this.db.prepare('SELECT actor_id,payload FROM action_proposals WHERE id=?')
            .get(row.owner_id) as { actor_id: string; payload: string };
          const payload = JSON.parse(source.payload) as SessionCompletionPayload;
          covered.set(JSON.stringify([source.actor_id,
            `session:${payload.sessionId}:${payload.sessionVersion}`]), bundle.effects);
        }
        const bundles: LiquidityClaimBundle[] = [];
        let changed = false;
        let currentReservationMode: ProspectiveClaimMode | null = null;
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
          const scope = claim?.scope;
          if (claim && row.actor_id &&
              (scope?.kind === 'account' || scope?.kind === 'category')) {
            const effects = covered.get(JSON.stringify([row.actor_id, claim.sourceId]));
            const kind = scope.kind === 'account' ? 'account_debit' : 'category';
            if (effects?.some((effect) =>
              effect.kind === kind && effect.resourceId === scope.id &&
              completionMoneyEquals(effect.amount, claim.amount)))
              continue;
          }
          const informationalReservation =
            row.mode !== null &&
            claim?.kind === 'reservation' &&
            bundle.state === 'active' &&
            !bundle.initiated &&
            (currentReservationMode ??=
              governedReservationMode(this.currentPolicy(budgetId).policy)) === 'inform';
          if (
            !informationalReservation &&
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
    legacySourceId?: string,
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
            (existing.economicObligationId === effect.economicObligationId ||
              existing.economicObligationId === legacySourceId),
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
    const mode = claim.kind === 'commitment' ? 'block' : governedReservationMode(policy.policy);
    return {
      mode,
      expiresAt,
      effect: {
        kind: scope.resourceKind === 'category' ? 'category' : 'account_debit',
        resourceId: scope.resourceId,
        amount: structuredClone(claim.amount),
        economicObligationId: `${claim.sourceId}:${scope.resourceKind}:${scope.resourceId}`,
        sourceEconomicObligationId: claim.sourceId,
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
  private prospectiveOriginCurrent(
    row: { actor_id: string; space_id: string | null; membership_id: string | null },
    input: LiquidityActor,
  ): boolean {
    const spaceId = input.spaceId ?? this.governance.getSpaceForBudget({ budgetId: input.budgetId })?.id;
    return !!row.space_id && row.space_id === spaceId && !!row.membership_id &&
      this.governance.getCurrentMembership({
        spaceId: row.space_id, actorId: row.actor_id, now: input.now ?? new Date().toISOString(),
      })?.id === row.membership_id;
  }

  private projectProspectiveClaim(
    row: {
      actor_id: string;
      space_id: string | null;
      membership_id: string | null;
      mode: ProspectiveClaimMode;
      lifecycle_state: ProspectiveClaimLifecycle;
      claim: string;
    },
    input: LiquidityActor,
    currentReservationMode?: ProspectiveClaimMode,
  ): StoredProspectiveClaim {
    const claim = JSON.parse(row.claim) as ProspectiveClaim;
    const scope = this.prospectiveScope(claim.scope);
    const visible =
      this.prospectiveOriginCurrent(row, input) && claim.visibility === 'visible' &&
      this.isAuthorized({
        ...input,
        capability: 'liquidity',
        resourceKind: scope.resourceKind,
        resourceId: scope.resourceId,
      });
    const lifecycleState = row.lifecycle_state;
    const mode = lifecycleState === 'active' && currentReservationMode
      ? claim.kind === 'commitment' ? 'block' : currentReservationMode
      : row.mode;
    const projected = this.storedProspectiveClaim(claim, mode, lifecycleState);
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
  /** Replays a client claim intent without treating its previously reserved charge as new funds. */
  replayProspectiveClaim(
    input: ProspectiveCreationIntent & { now: string },
  ): StoredProspectiveClaim | null {
    this.budget(input, 'liquidity');
    const scope = this.prospectiveScope(input.scope);
    this.requireResource({
      ...input, capability: 'liquidity',
      resourceKind: scope.resourceKind, resourceId: scope.resourceId,
    });
    time(input.now);
    const replay = this.replay<StoredProspectiveClaim>(
      input, 'prospective_claim:save', prospectiveCreationRequest(input),
    );
    if (!replay) return null;
    const current = this.listProspectiveClaims(input).find((claim) => claim.claimId === replay.claimId);
    if (!current) throw new Error('Claim authorization denied');
    return current;
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
        const replay = this.replay<StoredProspectiveClaim>(
          input, 'prospective_claim:save',
          prospectiveCreationRequest({ ...input, sourceId: input.claim.sourceId,
            kind: input.claim.kind, scope: input.claim.scope }),
        );
        if (replay) {
          const current = this.listProspectiveClaims(input).find((claim) => claim.claimId === replay.claimId);
          if (!current) throw new Error('Claim authorization denied');
          return current;
        }
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
        const sessionSource = /^session:(.+):[1-9]\d*$/.exec(input.claim.sourceId);
        if (sessionSource && this.hasVerifiedSessionCompletion(input.budgetId, sessionSource[1]!))
          throw new Error('Session already completed');
        this.claimSet(input.budgetId, input.now, input.actorId);
        this.assertNoDuplicateEconomicEffect(input.budgetId, effect, input.claim.sourceId);
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
        const context = this.currentMemberContext(input);
        if (!context) throw new Error('Claim authorization denied');
        this.db
          .prepare(
            'INSERT INTO liquidity_claim_metadata (budget_id,claim_id,actor_id,mode,lifecycle_state,source_id,policy_version,snapshot_id,claim,created_at,updated_at,space_id,membership_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
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
            context.spaceId,
            context.membershipId,
          );
        const result = this.projectProspectiveClaim(
          {
            actor_id: input.actorId,
            space_id: context.spaceId,
            membership_id: context.membershipId,
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
          prospectiveCreationRequest({ ...input, sourceId: input.claim.sourceId,
            kind: input.claim.kind, scope: input.claim.scope }),
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
            'SELECT actor_id,claim,space_id,membership_id FROM liquidity_claim_metadata WHERE budget_id=? AND claim_id=?',
          )
          .get(input.budgetId, input.claimId) as
          | { actor_id: string; claim: string; space_id: string | null; membership_id: string | null }
          | undefined;
        if (!replayAuthorization || !this.prospectiveOriginCurrent(replayAuthorization, input))
          throw new Error('Prospective claim unavailable');
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
            'SELECT actor_id,mode,lifecycle_state,source_id,policy_version,snapshot_id,claim,space_id,membership_id FROM liquidity_claim_metadata WHERE budget_id=? AND claim_id=?',
          )
          .get(input.budgetId, input.claimId) as
          | {
              actor_id: string;
              space_id: string | null;
              membership_id: string | null;
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
            space_id: row.space_id,
            membership_id: row.membership_id,
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
  /** Lists lifecycle history without exposing another actor's hidden claim timing or existence. */
  listProspectiveClaims(input: LiquidityActor & { now: string }): StoredProspectiveClaim[] {
    this.budget(input, 'liquidity');
    time(input.now);
    this.claimSet(input.budgetId, input.now, input.actorId);
    const rows = this.db
      .prepare(
        'SELECT actor_id,mode,lifecycle_state,claim,space_id,membership_id FROM liquidity_claim_metadata WHERE budget_id=? ORDER BY created_at,claim_id',
      )
      .all(input.budgetId) as {
      actor_id: string;
      space_id: string | null;
      membership_id: string | null;
      mode: ProspectiveClaimMode;
      lifecycle_state: ProspectiveClaimLifecycle;
      claim: string;
    }[];
    const activeReservationMode = rows.some((row) => row.lifecycle_state === 'active')
      ? governedReservationMode(this.currentPolicy(input.budgetId).policy)
      : undefined;
    return rows.flatMap((row) => {
      if (!this.prospectiveOriginCurrent(row, input)) return [];
      const claim = this.projectProspectiveClaim(row, input, activeReservationMode);
      return row.actor_id !== input.actorId && claim.visibility === 'redacted' ? [] : [claim];
    });
  }
  admitTransferProposal(input: AdmitTransferInput, validator: ClaimValidator): TransferProposal {
    this.authorizePlan(input, input.plan, 'proposal');
    if (!/^[a-f0-9]{64}$/.test(input.plan.payloadHash) || !input.plan.legs.length)
      throw new Error('Invalid transfer plan');
    return this.db
      .transaction(() => {
        this.authorizePlan(input, input.plan, 'proposal');
        const replay = this.replay<TransferProposal>(input, 'transfer:admit', input);
        if (replay) return this.getTransferProposalIntent({ ...input, proposalId: replay.id, capability: 'proposal' });
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
        const context = this.currentMemberContext(input);
        if (!context) throw new Error('Current human membership unavailable');
        const governancePolicyVersion = this.currentPolicy(input.budgetId).governancePolicyVersion;
        if (!governancePolicyVersion) throw new Error('Governance policy unavailable');
        this.db
          .prepare(
            "INSERT INTO action_proposals (id,operation,budget_id,payload_hash,policy_version,preconditions,expires_at,actor_id,provenance,provider_model,correlation_id,superseded_at,created_at,payload,version,state,space_id,requester_membership_id,governance_policy_version) VALUES (?,'transfer',?,?,?,?,?,?,'human',NULL,NULL,NULL,?,?,1,?,?,?,?)",
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
            context.spaceId,
            context.membershipId,
            governancePolicyVersion,
          );
        this.persistClaim(input.budgetId, 'proposal', id, bundle);
        const result = this.load(id);
        this.record(input, 'transfer:admit', id, input, result);
        return result;
      })
      .immediate();
  }
  private command(
    input: TransferCommand,
    capability: ResourceCapability,
    phaseOverride?: 'read' | 'propose' | 'approve' | 'execute',
  ): TransferProposal {
    const p = this.load(input.proposalId);
    if (p.budgetId !== input.budgetId) throw new Error('Resource authorization denied');
    if (!['initiated', 'confirmed', 'closed'].includes(p.state.phase)) {
      const origin = this.proposalOrigin(p.id, input.now);
      if (!origin) throw new Error('Pending proposal provenance is no longer current');
      this.authorizePlan(origin, p.payload.plan, 'proposal', false, 'propose');
    }
    const initiatedSettlement = capability === 'confirmation' &&
      ['initiated', 'confirmed'].includes(p.state.phase);
    const verifiedHumanApproval = !initiatedSettlement &&
      ['initiation-report', 'confirmation'].includes(capability) &&
      this.approvals(p, input.now, true).length >= this.requiredApprovers(p, input.now);
    this.authorizePlan(
      input,
      p.payload.plan,
      capability,
      verifiedHumanApproval,
      initiatedSettlement ? 'read' : phaseOverride,
    );
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
  private approvals(
    p: TransferProposal,
    now: string,
    includeConsumed = false,
  ): EligibleHumanApproval[] {
    if (!p.spaceId || !p.governancePolicyVersion) return [];
    const rows = this.db
      .prepare(includeConsumed
        ? "SELECT id,actor_id,status,created_at,expires_at,issuer_membership_id,governance_policy_version,reauthenticated_session_id,reauthenticated_at FROM proposal_approvals WHERE proposal_id=? AND payload_hash=? AND superseded_at IS NULL AND ((status='active' AND expires_at>? AND consumed_at IS NULL) OR (status='consumed' AND consumed_at IS NOT NULL)) ORDER BY created_at DESC,id"
        : "SELECT id,actor_id,status,created_at,expires_at,issuer_membership_id,governance_policy_version,reauthenticated_session_id,reauthenticated_at FROM proposal_approvals WHERE proposal_id=? AND payload_hash=? AND status='active' AND expires_at>? AND consumed_at IS NULL AND superseded_at IS NULL ORDER BY created_at DESC,id")
      .all(p.id, p.payloadHash, now) as {
      id: string;
      actor_id: string;
      status: string;
      created_at: string;
      expires_at: string;
      issuer_membership_id: string | null;
      governance_policy_version: string | null;
      reauthenticated_session_id: string | null;
      reauthenticated_at: string | null;
    }[];
    const accepted: EligibleHumanApproval[] = [];
    const actors = new Set<string>();
    for (const row of rows) {
      if (row.actor_id === p.actorId || actors.has(row.actor_id) || !row.issuer_membership_id ||
          row.governance_policy_version !== p.governancePolicyVersion ||
          !row.reauthenticated_session_id || !row.reauthenticated_at) continue;
      const membership = this.governance.getCurrentMembership({
        spaceId: p.spaceId,
        actorId: row.actor_id,
        now,
      });
      if (membership?.id !== row.issuer_membership_id) continue;
      const auth: HumanControlContext = {
        method: 'human-session',
        actorId: row.actor_id,
        sessionId: row.reauthenticated_session_id,
        reauthenticatedAt: row.reauthenticated_at,
      };
      const historical: LiquidityActor = {
        actorId: row.actor_id,
        budgetId: p.budgetId,
        spaceId: p.spaceId,
        membershipId: row.issuer_membership_id,
        governancePolicyVersion: row.governance_policy_version,
        now: row.created_at,
        auth,
      };
      try {
        this.authorizePlan(historical, p.payload.plan, 'approval');
        this.authorizePlan({ ...historical, now }, p.payload.plan, 'approval', false, 'read');
        actors.add(row.actor_id);
        accepted.push({
          id: row.id,
          approval: {
            actorId: row.actor_id,
            issuedAt: row.created_at,
            expiresAt: row.expires_at,
          },
        });
      } catch {
        // A stored approval is current only while its exact member and grants remain current.
      }
    }
    return accepted;
  }
  private requiredApprovers(p: TransferProposal, now: string): number {
    const policy = this.currentPolicy(p.budgetId).approvalPolicy;
    let count = policy.minimumApprovers;
    for (const t of policy.thresholds ?? [])
      if (
        t.currency === p.payload.plan.minimumAmount.currency &&
        BigInt(p.payload.plan.minimumAmount.minorUnits) >= BigInt(t.minimumMinorUnits)
      )
        count = Math.max(count, t.minimumApprovers);
    if (!p.spaceId) throw new Error('Governance policy unavailable');
    return Math.max(count, this.governanceRequiredApprovers(
      p.actorId,
      p.spaceId,
      p.budgetId,
      'transfer',
      transferOperations(p.payload.plan),
      this.resources(p.payload.plan),
      now,
    ));
  }
  /** Read-only approval summary at the service's trusted time; never expires rows using a second clock. */
  getTransferApprovalSummary(
    input: LiquidityActor & { proposalId: string; now: string },
  ): TransferApprovalSummary {
    return this.db
      .transaction(() => {
        time(input.now);
        const proposal = this.scopedTransferIntent(input);
        if (!(['liquidity', 'proposal', 'approval', 'initiation-report', 'confirmation', 'conclusion'] as const)
          .some((capability) => this.isTransferPlanAuthorized({
            ...input, plan: proposal.payload.plan, capability,
            phase: capability === 'proposal' ? 'propose' : 'read',
          })))
          throw new Error('Resource authorization denied');
        const ids = this.approvals(proposal, input.now);
        const own = this.db
          .prepare(
            "SELECT id FROM proposal_approvals WHERE proposal_id=? AND actor_id=? AND status='active'",
          )
          .all(proposal.id, input.actorId) as { id: string }[];
        return {
          requiredApprovals: this.requiredApprovers(proposal, input.now),
          approvalCount: ids.length,
          actorHasApproved: own.some((row) => ids.some((approval) => approval.id === row.id)),
          approvers: currentHumanApprovers(ids),
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
        const proof = this.humanApprovalProvenance(input);
        this.db
          .prepare(
            "INSERT INTO proposal_approvals (id,proposal_id,payload_hash,actor_id,status,expires_at,consumed_at,superseded_at,created_at,proposal_version,issuer_membership_id,governance_policy_version,reauthenticated_session_id,reauthenticated_at) VALUES (?,?,?,?,'active',?,NULL,NULL,?,?,?,?,?,?)",
          )
          .run(
            randomUUID(),
            p.id,
            p.payloadHash,
            input.actorId,
            p.expiresAt,
            input.now,
            p.version,
            proof.membershipId,
            proof.governancePolicyVersion,
            proof.reauthenticatedSessionId,
            proof.reauthenticatedAt,
          );
        const phase =
          this.approvals(p, input.now).length >= this.requiredApprovers(p, input.now)
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
      .prepare('SELECT record,space_id,membership_id FROM spend_sessions WHERE budget_id=? AND id=?')
      .get(p.budgetId, p.payload.sessionId) as
      { record: string; space_id: string | null; membership_id: string | null } | undefined;
    if (!row) throw new Error('Session unavailable');
    const session = normalizeSpendSession(JSON.parse(row.record));
    if (!p.spaceId || !p.requesterMembershipId || !p.governancePolicyVersion ||
        row.space_id !== p.spaceId || row.membership_id !== p.requesterMembershipId ||
        session.spaceId !== row.space_id || session.membershipId !== row.membership_id ||
        session.governancePolicyVersion !== p.governancePolicyVersion ||
        this.governance.getCurrentMembership({
          spaceId: session.spaceId,
          actorId: session.actorId,
          now,
        })?.id !== session.membershipId ||
        this.governance.getPolicy({ spaceId: session.spaceId })?.version !== session.governancePolicyVersion)
      throw new Error('Session governance provenance mismatch');
    future(session.expiresAt, now);
    if (session.version !== p.payload.sessionVersion) throw new Error('Session changed');
    return session;
  }
  /** Records a native recheck outcome without allowing an arbitrary state transition. */
  revalidateTransfer(input: RecheckTransferCommand, validator: ClaimValidator): TransferProposal {
    return this.db
      .transaction(() => {
        const p = this.command(input, 'initiation-report', 'propose');
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
          this.approvals(p, input.now).length < this.requiredApprovers(p, input.now)
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
        if (p.state.phase !== 'approved' || approvals.length < this.requiredApprovers(p, input.now))
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
        for (const approval of approvals)
          this.db
            .prepare(
              "UPDATE proposal_approvals SET status='consumed',consumed_at=? WHERE id=? AND status='active'",
            )
            .run(input.now, approval.id);
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
        this.requireHumanReconciliation(input);
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
    this.invalidateCompletionProposals(budgetId, now, sessionId);
  }
  expire(input: LiquidityActor & { now: string }): void {
    this.budget(input, 'proposal');
    time(input.now);
    this.db
      .transaction(() => {
        for (const p of this.listTransferProposalIntents({ ...input, capability: 'proposal' }))
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
    session: {
      items: readonly unknown[];
      accountId: string | null | undefined;
      adjustments?: unknown;
      warningThresholds?: unknown;
    },
  ): void {
    this.budget(input, 'session');
    if (session.accountId !== null && session.accountId !== undefined)
      this.requireResource({
        ...input,
        capability: 'liquidity',
        resourceKind: 'account',
        resourceId: session.accountId,
      });
    for (const item of session.items) {
      const source = sessionObject(item);
      this.requireResource({
        ...input,
        capability: 'category',
        resourceKind: 'category',
        resourceId: typeof source.categoryId === 'string' ? source.categoryId : '',
      });
      for (const accountId of sessionItemAccountIds(source))
        this.requireResource({
          ...input,
          capability: 'liquidity',
          resourceKind: 'account',
          resourceId: accountId,
        });
      if (Array.isArray(source.categoryAllocations))
        for (const allocation of source.categoryAllocations) {
          const category = sessionObject(allocation);
          this.requireResource({
            ...input,
            capability: 'category',
            resourceKind: 'category',
            resourceId: typeof category.categoryId === 'string' ? category.categoryId : '',
          });
        }
    }
    if (Array.isArray(session.adjustments))
      for (const adjustment of session.adjustments) {
        const category = sessionObject(adjustment);
        this.requireResource({
          ...input,
          capability: 'category',
          resourceKind: 'category',
          resourceId: typeof category.categoryId === 'string' ? category.categoryId : '',
        });
      }
    if (Array.isArray(session.warningThresholds))
      for (const threshold of session.warningThresholds) {
        const warning = sessionObject(threshold);
        if (warning.basis === 'category_charge')
          this.requireResource({
            ...input,
            capability: 'category',
            resourceKind: 'category',
            resourceId: typeof warning.categoryId === 'string' ? warning.categoryId : '',
          });
      }
  }
  getSpendSession(input: LiquidityActor & { id: string; now: string }): SpendSession | null {
    this.budget(input, 'session');
    const row = this.db
      .prepare('SELECT * FROM spend_sessions WHERE budget_id=? AND id=?')
      .get(input.budgetId, input.id) as
      { record: string; space_id: string | null; membership_id: string | null } | undefined;
    if (!row) return null;
    const context = this.currentMemberContext(input);
    if (!context || row.space_id !== context.spaceId || row.membership_id !== context.membershipId)
      throw new Error('Session membership provenance mismatch');
    const stored = JSON.parse(row.record);
    const source = sessionObject(stored);
    if (source.actorId !== input.actorId) throw new Error('Session authorization denied');
    const session = normalizeSpendSession(stored);
    this.sessionResources(input, {
      items: Array.isArray(source.items) ? source.items : [],
      accountId: optionalString(source.accountId),
      adjustments: source.adjustments,
      warningThresholds: source.warningThresholds,
    });
    future(session.expiresAt, input.now);
    return session;
  }
  listSpendSessions(input: LiquidityActor & { now: string }): SpendSession[] {
    this.budget(input, 'session');
    const context = this.currentMemberContext(input);
    if (!context) throw new Error('Current human membership unavailable');
    return (
      this.db
        .prepare('SELECT record,space_id,membership_id FROM spend_sessions WHERE budget_id=?')
        .all(input.budgetId) as { record: string; space_id: string | null; membership_id: string | null }[]
    )
      .filter((row) => row.space_id === context.spaceId && row.membership_id === context.membershipId)
      .map((row) => JSON.parse(row.record))
      .filter((stored) => {
        const source = sessionObject(stored);
        return (
          source.actorId === input.actorId &&
          typeof source.expiresAt === 'string' &&
          Date.parse(source.expiresAt) > Date.parse(input.now)
        );
      })
      .map((stored) => {
        const source = sessionObject(stored);
        this.sessionResources(input, {
          items: Array.isArray(source.items) ? source.items : [],
          accountId: optionalString(source.accountId),
          adjustments: source.adjustments,
          warningThresholds: source.warningThresholds,
        });
        return normalizeSpendSession(stored);
      });
  }
  saveSpendSession(input: SaveSpendSessionInput, validator: ClaimValidator): SpendSession {
    this.sessionResources(input, input);
    if (!this.currentMemberContext(input)) throw new Error('Current human membership unavailable');
    future(input.expiresAt, input.now);
    const items = input.items.map((item) => normalizeSessionItem(item));
    if (
      new Set(items.map((item) => item.id)).size !== items.length ||
      items.some((item) => !item.id)
    )
      throw new Error('Duplicate session item ID');
    for (const item of items) validateSessionItem(item, input.expiresAt);
    validateSessionExtras(input.adjustments, input.warningThresholds);
    return this.db
      .transaction(() => {
        this.sessionResources(input, input);
        const context = this.currentMemberContext(input);
        if (!context) throw new Error('Current human membership unavailable');
        const replay = this.replay<SpendSession>(input, 'session:save', input);
        if (replay) {
          if (replay.spaceId !== context.spaceId || replay.membershipId !== context.membershipId ||
              replay.governancePolicyVersion !== context.governancePolicyVersion)
            throw new Error('Session governance provenance mismatch');
          return normalizeSpendSession(replay);
        }
        const row = this.db
          .prepare('SELECT * FROM spend_sessions WHERE budget_id=? AND id=?')
          .get(input.budgetId, input.id) as
          { record: string; space_id: string | null; membership_id: string | null } | undefined;
        if (row && (row.space_id !== context.spaceId || row.membership_id !== context.membershipId))
          throw new Error('Session membership provenance mismatch');
        const previousRecord = row ? JSON.parse(row.record) : null;
        const previous = previousRecord ? normalizeSpendSession(previousRecord) : null;
        if (previous && previous.actorId !== input.actorId)
          throw new Error('Session authorization denied');
        if ((previous?.version ?? 0) !== input.expectedVersion)
          throw new Error('Session version conflict');
        if (previous) future(previous.expiresAt, input.now);
        if (previous && this.hasVerifiedSessionCompletion(input.budgetId, input.id))
          throw new Error('Session already completed');
        const existingClaimRow = previous
          ? (this.db
              .prepare(
                "SELECT bundle FROM liquidity_claims WHERE budget_id=? AND owner_kind='session' AND owner_id=?",
              )
              .get(input.budgetId, input.id) as { bundle: string } | undefined)
          : undefined;
        const existingClaim = existingClaimRow
          ? (JSON.parse(existingClaimRow.bundle) as LiquidityClaimBundle)
          : null;
        const initiatedExistingClaim =
          existingClaim?.initiated === true || existingClaim?.state === 'initiated';
        if (initiatedExistingClaim && input.claim)
          throw new Error('Initiated session claim cannot be replaced');
        const session: SpendSession = {
          actorId: input.actorId,
          budgetId: input.budgetId,
          spaceId: context.spaceId,
          membershipId: context.membershipId,
          governancePolicyVersion: context.governancePolicyVersion,
          id: input.id,
          version: input.expectedVersion + 1,
          items,
          ...(input.adjustments !== undefined
            ? { adjustments: structuredClone(input.adjustments) }
            : {}),
          ...(input.warningThresholds !== undefined
            ? { warningThresholds: structuredClone(input.warningThresholds) }
            : {}),
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
        } else if (existingClaim && !initiatedExistingClaim) {
          this.persistClaim(input.budgetId, 'session', input.id, {
            ...existingClaim,
            state: 'cancelled',
          });
        }
        this.db
          .prepare(`INSERT INTO spend_sessions (budget_id,id,record,space_id,membership_id) VALUES (?,?,?,?,?)
            ON CONFLICT(budget_id,id) DO UPDATE SET record=excluded.record`)
          .run(input.budgetId, input.id, JSON.stringify(session), context.spaceId, context.membershipId);
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
          .prepare('SELECT * FROM spend_sessions WHERE budget_id=? AND id=?')
          .get(input.budgetId, input.id) as
          { record: string; space_id: string | null; membership_id: string | null } | undefined;
        if (!row) throw new Error('Session unavailable');
        const context = this.currentMemberContext(input);
        if (!context || row.space_id !== context.spaceId || row.membership_id !== context.membershipId)
          throw new Error('Session membership provenance mismatch');
        const stored = JSON.parse(row.record);
        const source = sessionObject(stored);
        if (source.actorId !== input.actorId) throw new Error('Session authorization denied');
        this.sessionResources(input, {
          items: Array.isArray(source.items) ? source.items : [],
          accountId: optionalString(source.accountId),
          adjustments: source.adjustments,
          warningThresholds: source.warningThresholds,
        });
        const replay = this.replay<SpendSession>(input, 'session:cancel', input);
        if (replay) {
          if (replay.spaceId !== context.spaceId || replay.membershipId !== context.membershipId)
            throw new Error('Session membership provenance mismatch');
          return normalizeSpendSession(replay);
        }
        const previous = normalizeSpendSession(stored);
        if (previous.version !== input.expectedVersion) throw new Error('Session version conflict');
        if (this.hasVerifiedSessionCompletion(input.budgetId, input.id))
          throw new Error('Session already completed');
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
    this.budget(input, 'policy');
    const context = this.currentMemberContext(input);
    if (!context) throw new Error('Current human membership unavailable');
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
      this.requireResource({
        ...input,
        capability: 'policy',
        resourceKind: 'account',
        resourceId: observation.accountId,
      });
    }
    return this.db
      .transaction(() => {
        this.budget(input, 'policy');
        const writeContext = this.currentMemberContext(input);
        if (!writeContext || writeContext.spaceId !== context.spaceId ||
            writeContext.membershipId !== context.membershipId)
          throw new Error('Current human membership unavailable');
        for (const observation of input.observations)
          this.requireResource({
            ...input,
            capability: 'policy',
            resourceKind: 'account',
            resourceId: observation.accountId,
          });
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
          spaceId: context.spaceId,
          membershipId: context.membershipId,
          version: input.expectedVersion + 1,
          observations: structuredClone(input.observations),
          expiresAt: input.expiresAt,
          createdAt: input.now,
        };
        this.db
          .prepare(`INSERT INTO liquidity_supplemental_facts
            (budget_id,version,facts,actor_id,expires_at,created_at,space_id,membership_id)
            VALUES (?,?,?,?,?,?,?,?)`)
          .run(
            input.budgetId,
            record.version,
            JSON.stringify(input.observations),
            input.actorId,
            input.expiresAt,
            input.now,
            context.spaceId,
            context.membershipId,
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
      | {
          version: number;
          facts: string;
          actor_id: string;
          expires_at: string;
          created_at: string;
          space_id: string | null;
          membership_id: string | null;
        }
      | undefined;
    if (!row || !row.space_id || !row.membership_id ||
        Date.parse(row.expires_at) <= Date.parse(input.now) ||
        this.governance.getCurrentMembership({
          spaceId: row.space_id,
          actorId: row.actor_id,
          now: input.now,
        })?.id !== row.membership_id) return null;
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
      spaceId: row.space_id,
      membershipId: row.membership_id,
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
        const context = this.currentMemberContext(input);
        if (!context) throw new Error('Current governed membership unavailable');
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
          spaceId: context.spaceId,
          membershipId: context.membershipId,
          governancePolicyVersion: context.governancePolicyVersion,
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
          .prepare(`INSERT INTO payment_preferences (budget_id,id,record,space_id,membership_id)
            VALUES (?,?,?,?,?) ON CONFLICT(budget_id,id) DO UPDATE SET
              record=excluded.record,space_id=excluded.space_id,membership_id=excluded.membership_id`)
          .run(input.budgetId, input.id, JSON.stringify(record), context.spaceId, context.membershipId);
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
    const context = this.currentMemberContext(input);
    if (!context) return [];
    return (
      this.db
        .prepare('SELECT record FROM payment_preferences WHERE budget_id=?')
        .all(input.budgetId) as { record: string }[]
    )
      .map((r) => JSON.parse(r.record) as PaymentPreferenceRecord)
      .filter(
        (r) =>
          r.actorId === input.actorId &&
          r.spaceId === context.spaceId &&
          r.membershipId === context.membershipId &&
          r.governancePolicyVersion === context.governancePolicyVersion &&
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
            ...input,
            actorId: r.approvedBy,
            spaceId: context.spaceId,
            membershipId: context.membershipId,
            governancePolicyVersion: context.governancePolicyVersion,
            capability: 'approval',
            phase: 'read',
            resourceKind: 'account',
            resourceId: r.route.accountId,
          }),
      );
  }
  getTransferAudit(input: LiquidityActor & { proposalId: string }): unknown[] {
    const now = input.now ?? new Date().toISOString();
    const scoped = { ...input, now };
    const p = this.command(
      {
        ...scoped,
        payloadHash: this.getTransferProposal(scoped).payloadHash,
        expectedVersion: 0,
        idempotencyKey: '',
      },
      'audit',
    );
    return this.db
      .prepare('SELECT * FROM audit_records WHERE proposal_id=? ORDER BY timestamp,id')
      .all(p.id);
  }
}
