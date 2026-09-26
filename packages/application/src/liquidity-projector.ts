import type {
  AccountAwareSpendabilityRequest,
  AccountAwareSpendabilityResult,
  DecisionCard,
  DecisionCardState,
  FinancialSnapshot,
  LiquidityPurchaseItem,
  TransferPlan,
} from '@balanceframe/protocol-generated';
import type {
  Finding,
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
  PublicTransferConclusion,
  PublicTransferPlan,
} from './liquidity-public.js';

/** The sole allowlist for financial results. Canonical values never become public by spreading. */
export class LiquidityProjector {
  /** Linked findings and notifications cannot bypass current transfer visibility or audit grants. */
  static canReadFinding(store: WorkflowStore, actorId: string, finding: Finding): boolean {
    const transferId =
      finding.classification === 'transfer_needs_attention'
        ? finding.evidence.transferId
        : undefined;
    if (typeof transferId !== 'string') return true;
    const actor = { actorId, budgetId: finding.budgetId };
    try {
      const proposal = store.liquidity.getTransferProposal({ ...actor, proposalId: transferId });
      store.liquidity.requireResource({
        ...actor,
        resourceKind: 'budget',
        resourceId: actor.budgetId,
        capability: 'audit',
      });
      for (const leg of proposal.payload.plan.legs)
        for (const resourceId of [leg.sourceAccountId, leg.destinationAccountId])
          store.liquidity.requireResource({
            ...actor,
            resourceKind: 'account',
            resourceId,
            capability: 'audit',
          });
      if (proposal.payload.plan.scenario.kind === 'purchases')
        for (const item of proposal.payload.plan.scenario.items)
          store.liquidity.requireResource({
            ...actor,
            resourceKind: 'category',
            resourceId: item.categoryId,
            capability: 'audit',
          });
      return true;
    } catch {
      return false;
    }
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
      }),
    );
  }
  name(kind: 'account' | 'category', id: string): string | undefined {
    if (!this.allowed(kind, id, 'existence', 'name')) return undefined;
    return kind === 'account'
      ? this.snapshot.legacySnapshot.accounts.find((account) => account.id === id)?.name
      : this.snapshot.legacySnapshot.categories.find((category) => category.id === id)?.name;
  }
  planAuthorized(plan: TransferPlan, capability: ResourceCapability = 'proposal'): boolean {
    const resources: { kind: ResourceKind; id: string }[] = plan.legs.flatMap((leg) => [
      { kind: 'account', id: leg.sourceAccountId },
      { kind: 'account', id: leg.destinationAccountId },
    ]);
    if (plan.scenario.kind === 'purchases')
      for (const item of plan.scenario.items)
        resources.push({ kind: 'category', id: item.categoryId });
    for (const line of plan.backingAfter.lines)
      resources.push(
        { kind: 'account', id: line.accountId },
        { kind: 'category', id: line.categoryId },
      );
    return (
      this.allowed('budget', this.actor.budgetId, capability) &&
      resources.every((resource) =>
        this.allowed(
          resource.kind,
          resource.id,
          'existence',
          'name',
          'balance',
          'history',
          'liquidity',
          capability,
        ),
      ) &&
      plan.legs.every((leg) => this.allowed('account', leg.sourceAccountId, 'source'))
    );
  }
  transferConclusion(plan: TransferPlan, categoryId?: string): PublicTransferConclusion | null {
    if (
      !this.allowed('budget', this.actor.budgetId, 'conclusion') &&
      (!categoryId || !this.allowed('category', categoryId, 'conclusion'))
    )
      return null;
    const actionable = this.planAuthorized(plan);
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
  transferPlan(plan: TransferPlan): PublicTransferPlan {
    if (!this.planAuthorized(plan)) throw new Error('Resource authorization denied');
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
    const evidence = card.evidence.filter((reference) =>
      reference.authorized &&
      reference.redaction === 'visible' &&
      this.snapshot.observations.some(
        ({ scope, evidence: source }) =>
          source.some(
            ({ evidenceId, authorized, redaction }) =>
              evidenceId === reference.evidenceId && authorized && redaction === 'visible',
          ) &&
          (scope.kind === 'global'
            ? this.allowed('budget', this.actor.budgetId, 'history')
            : (scope.kind === 'account' || scope.kind === 'category') &&
              this.allowed(scope.kind, scope.id, 'history')),
      ),
    ).map(({ evidenceId, kind, authorized, redaction }) => ({
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
      selectionSource: card.selectionSource,
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
    const aggregate = this.allowed(
      'budget',
      this.actor.budgetId,
      'conclusion',
      'balance',
      'liquidity',
    );
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
                deductions: before?.deductions.map((deduction) => ({
                  reason: deduction.reason,
                  amount: deduction.amount,
                })),
                ...(fact && this.allowed('account', account.id, 'history')
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
                        source: evidence.source,
                        observedAt: evidence.observedAt,
                        expiresAt: evidence.expiresAt,
                        reasons: evidence.reasons,
                      })),
                    }
                  : {}),
              }
            : {}),
          reasons: numbers ? (before?.reasons ?? []) : [],
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
        return {
          id: category.id,
          name: this.name('category', category.id),
          ...(numbers
            ? {
                availabilityBefore: capacity?.authoritativeAvailability,
                availabilityAfter: capacity?.remainingAvailability ?? undefined,
              }
            : {}),
          feasible: aggregate && numbers ? (result?.backingAfter.feasible ?? null) : null,
          backing: numbers
            ? (result?.backingAfter.lines ?? []).flatMap((line) => {
                const fact = categoryFacts.get(line.cashBucketId);
                if (
                  line.categoryId !== category.id ||
                  fact?.categoryId !== category.id ||
                  !this.allowed('account', line.accountId, 'existence', 'balance', 'liquidity')
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
          reasons: numbers ? (capacity?.reasons ?? []) : [],
        };
      });
    const purchases: PublicPurchaseLiquidity[] = items
      .filter((item) => this.allowed('category', item.categoryId, 'existence'))
      .map((item) => {
        const purchase = result?.purchases.find((value) => value.itemId === item.id);
        const conclusion =
          this.allowed('category', item.categoryId, 'conclusion') ||
          this.allowed('budget', this.actor.budgetId, 'conclusion');
        const selected =
          purchase?.selectedAccountId ??
          item.routeSelection.explicitAccountId ??
          item.routeSelection.sessionAccountId;
        const selectedVisible = selected !== null && this.allowed('account', selected, 'existence');
        const selectedNumbers =
          selectedVisible && this.allowed('account', selected!, 'balance', 'liquidity');
        const credit = purchase?.credit;
        return {
          id: item.id,
          categoryId: item.categoryId,
          amount: item.amount,
          selectedAccountId: selectedVisible ? selected : null,
          routeOrigin: selectedVisible ? (purchase?.selectionSource ?? null) : null,
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
          reasons: aggregate ? (purchase?.reasons ?? ['liquidity_policy_required']) : [],
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
      horizon: aggregate && result ? result.horizon : { startsAt: now, endsAt: now },
      expiresAt: aggregate ? (result?.expiresAt ?? now) : now,
      ...(aggregate && result
        ? { snapshotId: result.snapshotId, policyVersion: result.policyVersion }
        : {}),
      fundingStatus: aggregate ? (result?.budgetFundingStatus ?? 'insufficient_data') : null,
      paymentStatus: aggregate ? (result?.paymentLiquidityStatus ?? 'insufficient_data') : null,
      reasons: aggregate ? (result?.reasons ?? ['liquidity_policy_required']) : [],
      assumptions: aggregate ? (result?.assumptions ?? []) : [],
      accounts,
      categories,
      purchases,
      canConfigure:
        this.store.liquidity.isOwner(this.actor) ||
        this.allowed('budget', this.actor.budgetId, 'policy'),
      canManageGrants: this.store.liquidity.isOwner(this.actor),
      canCreateSession: this.allowed('budget', this.actor.budgetId, 'session'),
    };
  }
}
