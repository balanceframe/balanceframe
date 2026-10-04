import type {
  AccountAwareSpendabilityRequest,
  AccountAwareSpendabilityResult,
  DecisionCard,
  DecisionCardState,
  FinancialSnapshot,
  LiquidityPurchaseItem,
  Transaction,
  TransferPlan,
} from '@balanceframe/protocol-generated';
import type {
  Finding,
  GovernanceOperation,
  GovernanceResourceRef,
  LiquidityActor,
  ResourceCapability,
  ResourceKind,
  WorkflowStore,
} from '@balanceframe/workflow-store';
import type {
  PublicCategoryBacking,
  PublicLiquidityAccount,
  PublicDecisionCard,
  PublicDecisionCardState,
  PublicLiquidityView,
  PublicPurchaseLiquidity,
  PublicLiquidityFinding,
  PublicTransferConclusion,
  PublicTransferPlan,
} from './liquidity-public.js';

type AuthorizationClosure = {
  resources: GovernanceResourceRef[];
  operations: GovernanceOperation[];
};

function transferAuthorizationClosure(plan: TransferPlan): AuthorizationClosure {
  const resources = new Map<string, GovernanceResourceRef>();
  const add = (resourceKind: ResourceKind, resourceId: string | null | undefined) => {
    if (resourceId) resources.set(`${resourceKind}:${resourceId}`, { resourceKind, resourceId });
  };
  for (const leg of plan.legs) {
    add('account', leg.sourceAccountId);
    add('account', leg.destinationAccountId);
  }
  for (const effect of plan.reservations) {
    add(effect.kind === 'category' ? 'category' : 'account', effect.resourceId);
    add('category', effect.categoryId);
  }
  for (const line of plan.backingAfter.lines) {
    add('account', line.accountId);
    add('category', line.categoryId);
  }
  if (plan.scenario.kind === 'purchases')
    for (const item of plan.scenario.items) {
      add('category', item.categoryId);
      for (const accountId of [
        item.routeSelection.explicitAccountId,
        item.routeSelection.sessionAccountId,
        item.routeSelection.approvedPreference?.accountId,
        item.routeSelection.historicalRoute?.accountId,
      ])
        add('account', accountId);
    }
  if (plan.scenario.kind === 'reallocation')
    for (const move of plan.scenario.moves) {
      add('category', move.sourceCategoryId);
      add('category', move.destinationCategoryId);
    }
  return {
    resources: [...resources.values()],
    operations: plan.legs.map((leg) => ({
      operation: 'transfer',
      direction: 'outgoing',
      amount: leg.amount,
      sourceAccountId: leg.sourceAccountId,
      destinationAccountId: leg.destinationAccountId,
    })),
  };
}

function financialAuthorizationClosure(
  snapshot: FinancialSnapshot,
  input: AccountAwareSpendabilityRequest | null,
  result: AccountAwareSpendabilityResult | null,
  items: readonly LiquidityPurchaseItem[],
): AuthorizationClosure {
  const resources = new Map<string, GovernanceResourceRef>();
  const operations: GovernanceOperation[] = [];
  const add = (resourceKind: ResourceKind, resourceId: string | null | undefined) => {
    if (resourceId) resources.set(`${resourceKind}:${resourceId}`, { resourceKind, resourceId });
  };
  const addTransaction = (transaction: Transaction): void => {
    add('transaction', transaction.id);
    add('account', transaction.accountId);
    add('account', transaction.transferAccountId);
    add('category', transaction.categoryId);
    for (const split of transaction.subtransactions) addTransaction(split);
  };
  const addPlan = (plan: TransferPlan): void => {
    const closure = transferAuthorizationClosure(plan);
    for (const resource of closure.resources) add(resource.resourceKind, resource.resourceId);
    operations.push(...closure.operations);
  };
  const source = input?.financialSnapshot ?? snapshot;
  const legacy = source.legacySnapshot;
  for (const account of legacy.accounts) add('account', account.id);
  for (const category of legacy.categories) add('category', category.id);
  for (const transaction of legacy.transactions) addTransaction(transaction);
  for (const schedule of legacy.schedules) add('account', schedule.accountId);
  for (const month of legacy.budgets)
    for (const categoryId of Object.keys(month.categories)) add('category', categoryId);
  for (const payee of legacy.payees) add('account', payee.transferAccountId);
  for (const account of source.liquidity?.accounts ?? []) {
    add('account', account.accountId);
    for (const id of account.baselineTransactionIds) add('transaction', id);
    for (const flow of account.unsettledFlows) {
      add('transaction', flow.transferTransactionId);
      for (const id of flow.matchedTransactionIds) add('transaction', id);
    }
    for (const obligation of account.obligations) {
      add('category', obligation.categoryId);
      add('commitment', obligation.economicObligationId);
      for (const id of obligation.matchedTransactionIds) add('transaction', id);
    }
    if (account.credit) {
      add('account', account.credit.paymentAccountId);
      add('category', account.credit.paymentCategoryId);
      add('commitment', account.credit.economicObligationId);
    }
  }
  for (const category of source.liquidity?.categories ?? []) add('category', category.categoryId);
  for (const schedule of source.liquidity?.schedules ?? []) {
    add('account', schedule.accountId);
    add('category', schedule.categoryId);
    add('rule', schedule.ruleId);
  }
  for (const observation of source.observations) {
    const scope = observation.scope;
    if (scope.kind === 'account' || scope.kind === 'category' || scope.kind === 'transaction')
      add(scope.kind, scope.id);
    for (const reference of observation.evidence) add('evidence', reference.evidenceId);
  }
  if (input) {
    for (const account of input.liquidityPolicy.accounts) {
      add('account', account.accountId);
      for (const categoryId of account.eligibleCategoryIds) add('category', categoryId);
    }
    for (const route of input.liquidityPolicy.transferRoutes) {
      add('account', route.sourceAccountId);
      add('account', route.destinationAccountId);
    }
    for (const bundle of input.claimSet.bundles) {
      if (bundle.state !== 'active' && bundle.state !== 'initiated') continue;
      add('reservation', bundle.id);
      for (const effect of bundle.effects) {
        add(effect.kind === 'category' ? 'category' : 'account', effect.resourceId);
        add('category', effect.categoryId);
      }
    }
    for (const line of input.priorAllocation?.lines ?? []) {
      add('account', line.accountId);
      add('category', line.categoryId);
    }
    if (input.scenario.kind === 'purchases')
      for (const item of input.scenario.items) {
        add('category', item.categoryId);
        const accountId = [
          item.routeSelection.explicitAccountId,
          item.routeSelection.sessionAccountId,
          item.routeSelection.approvedPreference?.accountId,
          item.routeSelection.historicalRoute?.accountId,
        ].find((id): id is string => id !== null && id !== undefined);
        add('account', accountId);
        operations.push({
          operation: 'purchase',
          direction: 'outgoing',
          amount: item.amount,
          categoryId: item.categoryId,
          ...(accountId === undefined ? {} : { accountId }),
        });
      }
    if (input.scenario.kind === 'reallocation')
      for (const move of input.scenario.moves) {
        add('category', move.sourceCategoryId);
        add('category', move.destinationCategoryId);
        operations.push({
          operation: 'reallocation',
          direction: 'outgoing',
          amount: move.amount,
          categoryId: move.sourceCategoryId,
        });
      }
  }
  for (const account of result?.accountsBefore ?? []) add('account', account.accountId);
  for (const account of result?.accountsAfter ?? []) add('account', account.accountId);
  for (const category of result?.categories ?? []) add('category', category.categoryId);
  for (const line of [
    ...(result?.backingBefore.lines ?? []),
    ...(result?.backingAfter.lines ?? []),
  ]) {
    add('account', line.accountId);
    add('category', line.categoryId);
  }
  for (const purchase of result?.purchases ?? []) {
    add('category', purchase.categoryId);
    add('account', purchase.selectedAccountId);
    add('account', purchase.selectedBefore?.accountId);
    add('account', purchase.selectedAfter?.accountId);
    for (const alternative of purchase.alternatives) add('account', alternative.accountId);
    if (purchase.credit) {
      add('account', purchase.credit.paymentAccountId);
      add('category', purchase.credit.paymentCategoryId);
    }
    if (purchase.transferPlan) addPlan(purchase.transferPlan);
  }
  for (const item of items) {
    add('category', item.categoryId);
    for (const accountId of [
      item.routeSelection.explicitAccountId,
      item.routeSelection.sessionAccountId,
      item.routeSelection.approvedPreference?.accountId,
      item.routeSelection.historicalRoute?.accountId,
    ])
      add('account', accountId);
  }
  return { resources: [...resources.values()], operations };
}

/** The sole allowlist for financial results. Canonical values never become public by spreading. */
export class LiquidityProjector {
  /** Findings never expose raw prose, evidence refs, or operation/resource identifiers. */
  static projectFinding(
    store: WorkflowStore,
    actor: LiquidityActor,
    finding: Finding,
  ): PublicLiquidityFinding | null {
    if (
      finding.budgetId !== actor.budgetId ||
      !actor.spaceId ||
      !actor.membershipId ||
      !actor.governancePolicyVersion ||
      actor.auth?.actorId !== actor.actorId
    )
      return null;
    const evidence = finding.evidence;
    const transferId =
      finding.classification === 'transfer_needs_attention' &&
      Object.prototype.hasOwnProperty.call(evidence, 'transferId')
        ? evidence.transferId
        : undefined;
    if (typeof transferId === 'string') {
      try {
        const proposal = store.liquidity.getTransferProposalIntent({
          ...actor, proposalId: transferId, capability: 'conclusion',
        });
        const transferConclusion = LiquidityProjector.transferConclusion(
          store,
          actor,
          proposal.payload.plan,
        );
        if (!transferConclusion) return null;
        return {
          id: finding.id,
          budgetId: finding.budgetId,
          classification: finding.classification,
          severity: finding.severity,
          status: finding.status,
          createdAt: finding.createdAt,
          updatedAt: finding.updatedAt,
          description: 'A transfer needs authorized review. An acknowledgement is not settlement.',
          transferConclusion,
        };
      } catch {
        return null;
      }
    }
    if (
      !store.liquidity.isAuthorized({
        ...actor,
        resourceKind: 'budget',
        resourceId: actor.budgetId,
        capability: 'history',
      })
    )
      return null;
    return {
      id: finding.id,
      budgetId: finding.budgetId,
      classification: finding.classification,
      severity: finding.severity,
      status: finding.status,
      createdAt: finding.createdAt,
      updatedAt: finding.updatedAt,
      description: 'A finding needs authorized review.',
      transferConclusion: null,
    };
  }
  static transferConclusion(
    store: WorkflowStore,
    actor: LiquidityActor,
    plan: TransferPlan,
    categoryId?: string,
  ): PublicTransferConclusion | null {
    const closure = transferAuthorizationClosure(plan);
    const budgetConclusion = store.liquidity.isTransferPlanAuthorized({
      ...actor,
      plan,
      capability: 'conclusion',
      phase: 'read',
    });
    const categoryConclusion =
      categoryId !== undefined &&
      closure.resources.some(
        (resource) => resource.resourceKind === 'category' && resource.resourceId === categoryId,
      ) &&
      store.liquidity.isAuthorized({
        ...actor,
        resourceKind: 'category',
        resourceId: categoryId,
        capability: 'conclusion',
        operation: 'transfer',
        operations: closure.operations,
        resources: closure.resources,
      });
    if (!budgetConclusion && !categoryConclusion) return null;
    const actionable = LiquidityProjector.planAuthorized(store, actor, plan);
    return {
      minimumAmount: plan.minimumAmount,
      requiredBy: plan.legs.map((leg) => leg.requiredBy).sort()[0]!,
      ...(actionable
        ? {
            estimatedArrival: plan.legs
              .map((leg) => leg.estimatedArrival)
              .sort()
              .at(-1)!,
          }
        : {}),
      authorizedHolderRequired: !actionable,
    };
  }
  constructor(
    private readonly store: WorkflowStore,
    readonly actor: LiquidityActor,
    readonly snapshot: FinancialSnapshot,
  ) {}
  allowed(kind: ResourceKind, id: string, ...capabilities: ResourceCapability[]): boolean {
    return capabilities.every((capability) =>
      this.store.liquidity.isAuthorized({
        ...this.actor,
        resourceKind: kind,
        resourceId: id,
        capability,
        ...(capability === 'initiation-report' || capability === 'confirmation'
          ? { phase: 'read' as const }
          : {}),
      }),
    );
  }
  allowedAtPhase(
    kind: ResourceKind,
    id: string,
    capability: ResourceCapability,
    phase: 'read',
  ): boolean {
    return this.store.liquidity.isAuthorized({
      ...this.actor,
      resourceKind: kind,
      resourceId: id,
      capability,
      phase,
    });
  }
  name(kind: 'account' | 'category', id: string): string | undefined {
    if (!this.allowed(kind, id, 'existence', 'name')) return undefined;
    return kind === 'account'
      ? this.snapshot.legacySnapshot.accounts.find((account) => account.id === id)?.name
      : this.snapshot.legacySnapshot.categories.find((category) => category.id === id)?.name;
  }
  private canControl(capability: 'grant:manage' | 'policy:manage'): boolean {
    return !!this.actor.spaceId && this.allowed('space', this.actor.spaceId, capability);
  }
  private aggregateConclusion(closure: AuthorizationClosure): boolean {
    return this.store.liquidity.isAuthorized({
      ...this.actor,
      resourceKind: 'budget',
      resourceId: this.actor.budgetId,
      capability: 'conclusion',
      visibility: 'aggregate',
      resources: closure.resources,
      operations: closure.operations,
    });
  }
  private budgetResourceConclusion(closure: AuthorizationClosure): boolean {
    return this.store.liquidity.isAuthorized({
      ...this.actor,
      resourceKind: 'budget',
      resourceId: this.actor.budgetId,
      capability: 'conclusion',
      visibility: 'resource',
      resources: closure.resources,
      operations: closure.operations,
    });
  }
  static planAuthorized(
    store: WorkflowStore,
    actor: LiquidityActor,
    plan: TransferPlan,
    capability: ResourceCapability = 'proposal',
    phase?: 'read',
  ): boolean {
    const allowed = (kind: ResourceKind, id: string, ...capabilities: ResourceCapability[]) =>
      capabilities.every((required) =>
        store.liquidity.isAuthorized({
          ...actor,
          resourceKind: kind,
          resourceId: id,
          capability: required,
          operation: 'transfer',
          phase: 'read',
        }),
      );
    const resources: { kind: ResourceKind; id: string }[] = plan.legs.flatMap((leg) => [
      { kind: 'account', id: leg.sourceAccountId },
      { kind: 'account', id: leg.destinationAccountId },
    ]);
    if (plan.scenario.kind === 'purchases')
      for (const item of plan.scenario.items) resources.push({ kind: 'category', id: item.categoryId });
    for (const line of plan.backingAfter.lines)
      resources.push(
        { kind: 'account', id: line.accountId },
        { kind: 'category', id: line.categoryId },
      );
    return (
      store.liquidity.isTransferPlanAuthorized({
        ...actor, plan, capability,
        ...(phase === undefined
          ? capability === 'initiation-report' || capability === 'confirmation'
            ? { phase: 'read' as const }
            : {}
          : { phase }),
      }) &&
      resources.every((resource) =>
        allowed(resource.kind, resource.id, 'existence', 'name', 'balance', 'history', 'liquidity'),
      ) &&
      plan.legs.every((leg) => allowed('account', leg.sourceAccountId, 'source'))
    );
  }
  planAuthorized(plan: TransferPlan, capability: ResourceCapability = 'proposal', phase?: 'read'): boolean {
    return LiquidityProjector.planAuthorized(this.store, this.actor, plan, capability, phase);
  }
  transferConclusion(plan: TransferPlan, categoryId?: string): PublicTransferConclusion | null {
    return LiquidityProjector.transferConclusion(this.store, this.actor, plan, categoryId);
  }
  transferPlan(plan: TransferPlan): PublicTransferPlan {
    if (!this.planAuthorized(plan, 'liquidity', 'read')) throw new Error('Resource authorization denied');
    return {
      minimumAmount: plan.minimumAmount,
      requiredBy: plan.legs.map((leg) => leg.requiredBy).sort()[0]!,
      estimatedArrival: plan.legs
        .map((leg) => leg.estimatedArrival)
        .sort()
        .at(-1)!,
      expiresAt: plan.expiresAt,
      snapshotId: plan.snapshotId,
      policyVersion: plan.policyVersion,
      legs: plan.legs.map((leg) => ({
        sourceAccountId: leg.sourceAccountId,
        sourceAccountName: this.name('account', leg.sourceAccountId),
        destinationAccountId: leg.destinationAccountId,
        destinationAccountName: this.name('account', leg.destinationAccountId),
        amount: leg.amount,
        sourceCapacityBefore: leg.sourceBefore.signedHeadroom,
        sourceCapacityAfter: leg.sourceAfter,
        destinationCapacityBefore: leg.destinationBefore.signedHeadroom,
        destinationCapacityAfter: leg.destinationAfter,
      })),
      reasons: [],
      assumptions: ['manual_transfer_only', 'acknowledgement_is_not_settlement'],
    };
  }
  /**
   * Projects a native Decision Card only when every contributing financial scope
   * is currently visible. An incomplete scope gets no financial inference.
   */
  card(card: DecisionCard): PublicDecisionCard {
    const full = ['existence', 'balance', 'history', 'liquidity'] as const;
    const stateVisible = (state: DecisionCardState | null) =>
      state === null ||
      (
        state.categories.every(({ categoryId }) => this.allowed('category', categoryId, ...full)) &&
        state.accounts.every(({ accountId }) => this.allowed('account', accountId, ...full)) &&
        state.backing.lines.every(({ accountId, categoryId }) =>
          this.allowed('account', accountId, ...full) && this.allowed('category', categoryId, ...full),
        ) &&
        state.goals.every(({ categoryId }) => this.allowed('category', categoryId, ...full)) &&
        state.obligations.every(({ accountId, categoryId }) =>
          (accountId === null || this.allowed('account', accountId, ...full)) &&
          (categoryId === null || this.allowed('category', categoryId, ...full)),
        ) &&
        (state.runway?.accountId === undefined ||
          this.allowed('account', state.runway.accountId, ...full))
      );
    const visible = this.allowed(
      'budget',
      this.actor.budgetId,
      'conclusion',
      'balance',
      'history',
      'liquidity',
    ) &&
      this.snapshot.legacySnapshot.accounts.every(({ id }) => this.allowed('account', id, ...full)) &&
      this.snapshot.legacySnapshot.categories.every(({ id }) => this.allowed('category', id, ...full)) &&
      (this.snapshot.liquidity?.accounts ?? []).every(({ accountId }) =>
        this.allowed('account', accountId, ...full),
      ) &&
      (this.snapshot.liquidity?.categories ?? []).every(({ categoryId }) =>
        this.allowed('category', categoryId, ...full),
      ) &&
      card.items.every(({ categoryId, selectedAccountId }) =>
        this.allowed('category', categoryId, ...full) &&
        (selectedAccountId === null || this.allowed('account', selectedAccountId, ...full)),
      ) &&
      card.fundingPaths.every((path) =>
        path.kind === 'account_transfer'
          ? this.planAuthorized(path)
          : this.allowed('category', path.sourceCategoryId, ...full) &&
            this.allowed('category', path.destinationCategoryId, ...full),
      ) &&
      stateVisible(card.before) &&
      stateVisible(card.after) &&
      (card.selectedAccountId === null || this.allowed('account', card.selectedAccountId, ...full)) &&
      (card.cart === null ||
        (
          card.cart.categoryCharges.every(({ categoryId }) => this.allowed('category', categoryId, ...full)) &&
          card.cart.accountCharges.every(({ accountId }) => this.allowed('account', accountId, ...full))
        )) &&
      card.trimAlternatives.every(({ categoryCharges }) =>
        categoryCharges.every(({ categoryId }) => this.allowed('category', categoryId, ...full)),
      );
    if (!visible)
      return {
        outcome: 'insufficient_data',
        budgetFundingStatus: 'insufficient_data',
        paymentLiquidityStatus: 'insufficient_data',
        selectedAccountId: null,
        before: null,
        after: null,
        fundingPaths: [],
        evidence: [],
        blockers: ['restricted_financial_scope'],
        cart: null,
        warnings: [],
        trimAlternatives: [],
      };

    const account = (entry: DecisionCardState['accounts'][number]) => ({
      accountId: entry.accountId,
      recordedBalance: entry.recordedBalance,
      adjustedCash: entry.adjustedCash,
      signedHeadroom: entry.signedHeadroom,
      existingShortfall: entry.existingShortfall,
      safeSpendingCapacity: entry.safeSpendingCapacity,
      safeTransferCapacity: entry.safeTransferCapacity,
      backingCapacity: entry.backingCapacity,
      deductions: entry.deductions.map(({ reason, amount, affectsBacking }) => ({
        reason,
        amount,
        affectsBacking,
      })),
      reasons: entry.reasons,
    });
    const state = (value: DecisionCardState | null): PublicDecisionCardState | null =>
      value === null
        ? null
        : {
            categories: value.categories.map((category) => ({
              categoryId: category.categoryId,
              asOfMonth: category.asOfMonth,
              availability: category.availability,
              commitments: category.commitments,
              reservations: category.reservations,
              uncommittedAvailability: category.uncommittedAvailability,
              safeToRedirect: category.safeToRedirect,
              policyKind: category.policyKind,
            })),
            accounts: value.accounts.map(account),
            backing: {
              feasible: value.backing.feasible,
              lines: value.backing.lines.map(({ accountId, categoryId, cashBucketId, amount }) => ({
                accountId,
                categoryId,
                cashBucketId,
                amount,
              })),
              reasons: value.backing.reasons,
            },
            goals: value.goals.map((goal) => ({
              categoryId: goal.categoryId,
              asOfMonth: goal.asOfMonth,
              kind: goal.kind,
              state: goal.state,
              shortfall: goal.shortfall,
              minimumRetained: goal.minimumRetained,
              projectedRemainingNeed: goal.projectedRemainingNeed,
              requiredRetained: goal.requiredRetained,
              targetState: goal.targetState,
              availability: goal.availability,
              uncommittedAvailability: goal.uncommittedAvailability,
            })),
            obligations: value.obligations.map((obligation) =>
              obligation.amount === null
                ? {
                    scheduleId: obligation.scheduleId,
                    classification: obligation.classification,
                    accountId: obligation.accountId,
                    categoryId: obligation.categoryId,
                    dueAt: obligation.dueAt,
                    state: obligation.state,
                    recurring: obligation.recurring,
                    amount: null,
                    amountState: obligation.amountState,
                    recurrence: obligation.recurrence,
                  }
                : {
                    economicObligationId: obligation.economicObligationId,
                    classification: obligation.classification,
                    accountId: obligation.accountId,
                    categoryId: obligation.categoryId,
                    amount: obligation.amount,
                    state: obligation.state,
                    dueAt: obligation.dueAt,
                    recurring: obligation.recurring,
                    scheduleId: obligation.scheduleId,
                    recurrence: obligation.recurrence,
                    amountState: obligation.amountState,
                  },
            ),
            runway: value.runway?.state === 'known'
              ? {
                  state: 'known',
                  accountId: value.runway.accountId,
                  remainingSafeCash: value.runway.remainingSafeCash,
                  basis: value.runway.basis,
                }
              : value.runway?.state === 'unknown'
                ? {
                    state: 'unknown',
                    accountId: value.runway.accountId,
                    remainingSafeCash: null,
                  }
                : null,
          };
    const evidenceCapabilityByKind: Record<string, ResourceCapability> = {
      receipt: 'raw-document',
      normalized_receipt: 'normalized-evidence',
      transaction: 'ledger-effect',
    };
    const evidence = card.evidence.filter((reference) => {
      if (!reference.authorized || reference.redaction !== 'visible') return false;
      const capability = Object.prototype.hasOwnProperty.call(evidenceCapabilityByKind, reference.kind)
        ? evidenceCapabilityByKind[reference.kind]
        : reference.kind === 'bank_sync' ? null : 'evidence';
      return this.snapshot.observations.some(({ scope, evidence: source }) => {
        if (
          !source.some(
            ({ evidenceId, authorized, redaction }) =>
              evidenceId === reference.evidenceId && authorized && redaction === 'visible',
          )
        )
          return false;
        const scopeReadable =
          scope.kind === 'global'
            ? this.allowed('budget', this.actor.budgetId, 'history')
            : (scope.kind === 'account' || scope.kind === 'category') &&
              this.allowed(scope.kind, scope.id, 'history');
        if (!scopeReadable) return false;
        if (reference.kind === 'bank_sync')
          return scope.kind === 'global'
            ? this.allowed('budget', this.actor.budgetId, 'source')
            : (scope.kind === 'account' || scope.kind === 'category') &&
              this.allowed(scope.kind, scope.id, 'source');
        return this.allowed('evidence', reference.evidenceId, capability!);
      });
    }).map(({ evidenceId, kind, authorized, redaction }) => ({
      evidenceId,
      kind,
      authorized,
      redaction,
    }));
    return {
      outcome: card.outcome,
      budgetFundingStatus: card.budgetFundingStatus,
      paymentLiquidityStatus: card.paymentLiquidityStatus,
      selectedAccountId: card.selectedAccountId,
      selectionSource:
        card.selectedAccountId === null || this.allowed('account', card.selectedAccountId, 'source')
          ? card.selectionSource
          : null,
      before: state(card.before),
      after: state(card.after),
      fundingPaths: card.fundingPaths.map((path) =>
        path.kind === 'account_transfer'
          ? {
              kind: path.kind,
              itemIds: path.itemIds,
              minimumAmount: path.minimumAmount,
              expiresAt: path.expiresAt,
              legs: path.legs.map((leg) => ({
                sourceAccountId: leg.sourceAccountId,
                destinationAccountId: leg.destinationAccountId,
                amount: leg.amount,
                requiredBy: leg.requiredBy,
                estimatedArrival: leg.estimatedArrival,
                sourceBefore: leg.sourceBefore.signedHeadroom,
                destinationBefore: leg.destinationBefore.signedHeadroom,
                sourceAfter: leg.sourceAfter,
                destinationAfter: leg.destinationAfter,
              })),
            }
          : {
              kind: path.kind,
              sourceCategoryId: path.sourceCategoryId,
              sourceAsOfMonth: path.sourceAsOfMonth,
              destinationCategoryId: path.destinationCategoryId,
              destinationAsOfMonth: path.destinationAsOfMonth,
              amount: path.amount,
              approvalRequired: path.approvalRequired,
              tradeoffs: path.tradeoffs,
              before: {
                sourceAvailability: path.before.sourceAvailability,
                destinationAvailability: path.before.destinationAvailability,
              },
              after: {
                sourceAvailability: path.after.sourceAvailability,
                destinationAvailability: path.after.destinationAvailability,
              },
            },
      ),
      opportunityCosts: card.opportunityCosts.map((cost) => ({
        kind: cost.kind,
        sourceCategoryId: cost.sourceCategoryId,
        sourceAsOfMonth: cost.sourceAsOfMonth,
        destinationCategoryId: cost.destinationCategoryId,
        destinationAsOfMonth: cost.destinationAsOfMonth,
        amount: cost.amount,
        beforeSafeToRedirect: cost.beforeSafeToRedirect,
        afterSafeToRedirect: cost.afterSafeToRedirect,
        tradeoff: cost.tradeoff,
      })),
      conflicts: card.conflicts.map((conflict) => ({
        kind: conflict.kind,
        accountId: conflict.accountId,
        itemId: conflict.itemId,
        competingItemIds: conflict.competingItemIds,
        reason: conflict.reason,
        paymentLiquidityStatus: conflict.paymentLiquidityStatus,
      })),
      authorizationRequirements: card.authorizationRequirements,
      evidence,
      blockers: card.blockers,
      reasons: card.reasons,
      assumptions: card.assumptions,
      earliestExpiry: card.earliestExpiry,
      expiresAt: card.expiresAt,
      intentHash: card.intentHash,
      cart: card.cart === null
        ? null
        : {
            subtotal: card.cart.subtotal,
            tax: card.cart.tax,
            fee: card.cart.fee,
            discount: card.cart.discount,
            total: card.cart.total,
            categoryCharges: card.cart.categoryCharges.map(({ categoryId, amount }) => ({
              categoryId,
              amount,
            })),
            accountCharges: card.cart.accountCharges.map(({ accountId, amount }) => ({
              accountId,
              amount,
            })),
          },
      trimAlternatives: card.trimAlternatives.map((alternative) => ({
        removedItemIds: alternative.removedItemIds,
        retainedItemIds: alternative.retainedItemIds,
        total: alternative.total,
        outcome: alternative.outcome,
        categoryCharges: alternative.categoryCharges.map(({ categoryId, amount }) => ({
          categoryId,
          amount,
        })),
      })),
      warnings: card.warnings.map((warning) => ({
        thresholdId: warning.thresholdId,
        threshold: warning.threshold,
        actual: warning.actual,
        excess: warning.excess,
        reason: warning.reason,
        alternatives: warning.alternatives.map((alternative) => ({
          removedItemIds: alternative.removedItemIds,
          retainedItemIds: alternative.retainedItemIds,
          total: alternative.total,
          outcome: alternative.outcome,
          categoryCharges: alternative.categoryCharges.map(({ categoryId, amount }) => ({
            categoryId,
            amount,
          })),
        })),
      })),
      readiness: {
        outcome: card.readiness.outcome,
        status: card.readiness.status,
        blockers: card.readiness.blockers,
        budgetFundingStatus: card.readiness.budgetFundingStatus,
        paymentLiquidityStatus: card.readiness.paymentLiquidityStatus,
      },
      items: card.items.map((item) => ({
        id: item.id,
        categoryId: item.categoryId,
        amount: item.amount,
        priority: item.priority,
        outcome: item.outcome,
        budgetFundingStatus: item.budgetFundingStatus,
        paymentLiquidityStatus: item.paymentLiquidityStatus,
        selectedAccountId: item.selectedAccountId,
        selectionSource: item.selectionSource,
        reasons: item.reasons,
        before: item.before === null ? null : account(item.before),
        after: item.after === null ? null : account(item.after),
      })),
    };
  }

  view(
    input: AccountAwareSpendabilityRequest | null,
    result: AccountAwareSpendabilityResult | null,
    now: string,
    items: LiquidityPurchaseItem[] = [],
  ): PublicLiquidityView {
    const closure = financialAuthorizationClosure(this.snapshot, input, result, items);
    const aggregate = this.aggregateConclusion(closure);
    const aggregateDetail =
      aggregate && this.allowed('budget', this.actor.budgetId, 'balance', 'liquidity');
    const evaluatedAtMillis = Date.parse(now);
    const accounts: PublicLiquidityAccount[] = this.snapshot.legacySnapshot.accounts
      .filter((account) => this.allowed('account', account.id, 'existence'))
      .map((account) => {
        const fact = this.snapshot.liquidity?.accounts.find(
          (value) => value.accountId === account.id,
        );
        const before = result?.accountsBefore.find((value) => value.accountId === account.id);
        const after = result?.accountsAfter.find((value) => value.accountId === account.id);
        const numbers = this.allowed('account', account.id, 'balance', 'liquidity');
        const history = this.allowed('account', account.id, 'history');
        const source = this.allowed('account', account.id, 'source');
        return {
          id: account.id,
          name: this.name('account', account.id),
          ...(this.allowed('account', account.id, 'liquidity')
            ? {
                currency: fact?.currencyEvidence.state === 'known' ? fact.currency : undefined,
                role: input?.liquidityPolicy.accounts.find(
                  (value) => value.accountId === account.id,
                )?.role,
              }
            : {}),
          ...(this.allowed('account', account.id, 'balance') &&
          fact?.balanceEvidence.state === 'known'
            ? { balance: fact.recordedBalance }
            : {}),
          ...(numbers
            ? {
                safeSpendingBefore: before?.safeSpendingCapacity ?? undefined,
                safeSpendingAfter: after?.safeSpendingCapacity ?? undefined,
                safeTransfer: before?.safeTransferCapacity ?? undefined,
                backingCapacity: before?.backingCapacity ?? undefined,
                signedHeadroom: before?.signedHeadroom ?? undefined,
                ...(history
                  ? {
                      deductions: before?.deductions.map((deduction) => ({
                        reason: deduction.reason,
                        amount: deduction.amount,
                      })),
                    }
                  : {}),
                ...(fact && history
                  ? {
                      quality: [
                        fact.balanceEvidence,
                        fact.freshnessEvidence,
                        fact.currencyEvidence,
                        fact.kindEvidence,
                        fact.ownershipEvidence,
                        fact.holdsEvidence,
                        fact.activityEvidence,
                        fact.scheduleEvidence,
                      ].map((evidence) => ({
                        state: evidence.state,
                        ...(source ? { source: evidence.source } : {}),
                        observedAt: evidence.observedAt,
                        expiresAt: evidence.expiresAt,
                        reasons: evidence.reasons,
                      })),
                    }
                  : {}),
              }
            : {}),
          reasons: numbers && history ? (before?.reasons ?? []) : [],
        };
      });
    const categoryFacts = new Map(
      (this.snapshot.liquidity?.categories ?? []).map((fact) => [fact.cashBucketId, fact]),
    );
    const categories: PublicCategoryBacking[] = this.snapshot.legacySnapshot.categories
      .filter((category) => this.allowed('category', category.id, 'existence'))
      .map((category) => {
        const current = this.snapshot.liquidity?.categories.find(
          (fact) =>
            fact.categoryId === category.id &&
            fact.periodKind === 'current' &&
            fact.asOfMonth === this.snapshot.liquidity?.asOfMonth,
        );
        const capacity = current
          ? result?.categories.find((value) => value.cashBucketId === current.cashBucketId)
          : undefined;
        const numbers = this.allowed('category', category.id, 'balance', 'liquidity');
        const history = this.allowed('category', category.id, 'history');
        return {
          id: category.id,
          name: this.name('category', category.id),
          ...(numbers
            ? {
                availabilityBefore: capacity?.authoritativeAvailability,
                availabilityAfter: capacity?.remainingAvailability ?? undefined,
              }
            : {}),
          feasible:
            numbers && aggregate ? (result?.backingAfter.feasible ?? null) : null,
          backing: numbers
            ? (result?.backingAfter.lines ?? []).flatMap((line) => {
                const fact = categoryFacts.get(line.cashBucketId);
                if (
                  line.categoryId !== category.id ||
                  fact?.categoryId !== category.id ||
                  !history ||
                  !this.allowed(
                    'account',
                    line.accountId,
                    'existence',
                    'balance',
                    'liquidity',
                    'history',
                  )
                )
                  return [];
                return [
                  {
                    accountId: line.accountId,
                    accountName: this.name('account', line.accountId),
                    amount: line.amount,
                    asOfMonth: fact.asOfMonth,
                    periodKind: fact.periodKind,
                  },
                ];
              })
            : [],
          reasons: numbers && history ? (capacity?.reasons ?? []) : [],
        };
      });
    const purchases: PublicPurchaseLiquidity[] = items
      .filter((item) => this.allowed('category', item.categoryId, 'existence'))
      .map((item) => {
        const purchase = result?.purchases.find((value) => value.itemId === item.id);
        const conclusion =
          this.store.liquidity.isAuthorized({
            ...this.actor,
            resourceKind: 'category',
            resourceId: item.categoryId,
            capability: 'conclusion',
            resources: closure.resources,
            operations: closure.operations,
          }) || this.budgetResourceConclusion(closure);
        const selected =
          purchase?.selectedAccountId ??
          item.routeSelection.explicitAccountId ??
          item.routeSelection.sessionAccountId;
        const selectedVisible = selected !== null && this.allowed('account', selected, 'existence');
        const selectedNumbers =
          selectedVisible && this.allowed('account', selected!, 'balance', 'liquidity');
        const credit = purchase?.credit;
        const details = this.allowed('category', item.categoryId, 'balance', 'history', 'liquidity') &&
          (selected === null || this.allowed('account', selected, 'balance', 'history', 'liquidity'));
        return {
          categoryId: item.categoryId,
          ...(conclusion ? { id: item.id, amount: item.amount } : {}),
          selectedAccountId: selectedVisible ? selected : null,
          routeOrigin:
            selectedVisible && this.allowed('account', selected!, 'source')
              ? (purchase?.selectionSource ?? null)
              : null,
          fundingStatus: conclusion ? (purchase?.budgetFundingStatus ?? 'insufficient_data') : null,
          paymentStatus: conclusion
            ? (purchase?.paymentLiquidityStatus ?? 'insufficient_data')
            : null,
          ...(selectedNumbers
            ? {
                safeCapacityBefore: purchase?.selectedBefore?.safeSpendingCapacity ?? undefined,
                safeCapacityAfter: purchase?.selectedAfter?.safeSpendingCapacity ?? undefined,
              }
            : {}),
          alternatives: (purchase?.alternatives ?? [])
            .filter((alternative) =>
              this.allowed(
                'account',
                alternative.accountId,
                'existence',
                'liquidity',
                'conclusion',
              ),
            )
            .map((alternative) => ({
              accountId: alternative.accountId,
              accountName: this.name('account', alternative.accountId),
              status: alternative.status,
            })),
          transfer: purchase?.transferPlan
            ? this.transferConclusion(purchase.transferPlan, item.categoryId)
            : null,
          ...(credit &&
          selectedNumbers &&
          this.allowed(
            'account',
            credit.paymentAccountId,
            'existence',
            'balance',
            'liquidity',
            'conclusion',
          )
            ? {
                credit: {
                  authorizationBefore: credit.authorizationAvailable,
                  authorizationAfter: credit.authorizationAfter,
                  paymentAccountId: credit.paymentAccountId,
                  paymentAccountName: this.name('account', credit.paymentAccountId),
                  paymentDueAt: credit.dueAt,
                  paymentCashStatus: credit.paymentCashReady
                    ? ('ready' as const)
                    : ('not_liquid' as const),
                },
              }
            : {}),
          reasons: details ? (purchase?.reasons ?? ['liquidity_policy_required']) : [],
          canPlanTransfer:
            !!purchase?.transferPlan &&
            purchase.paymentLiquidityStatus === 'transfer_required' &&
            (purchase.transferPlan.scenario.kind !== 'purchases' ||
              purchase.transferPlan.scenario.items.every(
                (planned) => Date.parse(planned.purchaseAt) > evaluatedAtMillis,
              )) &&
            this.planAuthorized(purchase.transferPlan),
        };
      });
    return {
      evaluatedAt: now,
      horizon: aggregateDetail && result ? result.horizon : { startsAt: now, endsAt: now },
      expiresAt:
        aggregateDetail && this.allowed('budget', this.actor.budgetId, 'history')
          ? (result?.expiresAt ?? now)
          : now,
      ...(aggregateDetail && result
        ? { snapshotId: result.snapshotId, policyVersion: result.policyVersion }
        : {}),
      fundingStatus: aggregate ? (result?.budgetFundingStatus ?? 'insufficient_data') : null,
      paymentStatus: aggregate ? (result?.paymentLiquidityStatus ?? 'insufficient_data') : null,
      reasons:
        aggregateDetail && this.allowed('budget', this.actor.budgetId, 'history')
          ? (result?.reasons ?? ['liquidity_policy_required'])
          : [],
      assumptions:
        aggregateDetail && this.allowed('budget', this.actor.budgetId, 'history')
          ? (result?.assumptions ?? [])
          : [],
      accounts,
      categories,
      purchases,
      canConfigure:
        this.canControl('policy:manage') &&
        this.allowed('budget', this.actor.budgetId, 'policy'),
      canManageGrants: this.canControl('grant:manage'),
      canCreateSession: this.allowed('budget', this.actor.budgetId, 'session'),
    };
  }
}
