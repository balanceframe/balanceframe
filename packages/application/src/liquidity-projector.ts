import type {
  AccountAwareSpendabilityRequest,
  AccountAwareSpendabilityResult,
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
