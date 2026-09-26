import { createHash, randomUUID } from 'node:crypto';
import type { ConnectionManager } from './connection-manager.js';
import type {
  WorkflowStore,
  LiquidityActor,
  ClaimValidationContext,
  SpendSession,
  TransferProposal,
  ResourceCapability,
  ResourceKind,
  LiquidityPolicyRecord,
  SupplementalFactsRecord,
  PaymentPreferenceRecord,
} from '@balanceframe/workflow-store';
import type {
  AccountAwareSpendabilityRequest,
  AccountAwareSpendabilityResult,
  FinancialSnapshot,
  LiquidityPolicy,
  LiquidityPurchaseItem,
  LiquidityScenario,
  TransferPlan,
  TransferSettlementRecord,
  LiquidityClaimSet,
  BackingAllocation,
} from '@balanceframe/protocol-generated';
import {
  accountAwareSpendabilityResultSchema,
  financialSnapshotSchema,
  liquidityPolicySchema,
  transferPreconditionResultSchema,
  transferSettlementResultSchema,
} from '@balanceframe/protocol-generated/validators';
import {
  bindUserAttestedLiquidityObservations,
  mergeUserAttestedLiquidityObservations,
  persistedUserAttestedLiquidityObservationSchema,
} from '@balanceframe/actual-adapter';
import type { PurchaseEvaluationResult } from './commands.js';
import type {
  PublicLiquidityConfiguration,
  PublicLiquidityGrants,
  PublicLiquidityView,
  PublicSpendSession,
  PublicTransferDetail,
  PublicTransferPreview,
  PublicUserAttestedObservation,
} from './liquidity-public.js';
import { LiquidityProjector } from './liquidity-projector.js';
import {
  liquidityCapabilities,
  liquidityGrantInputSchema,
  liquidityObservationInputSchema,
  liquidityPolicyInputSchema,
  liquidityPurchaseInputSchema,
  liquidityReallocationInputSchema,
  spendSessionCancelInputSchema,
  spendSessionInputSchema,
  spendSessionUpdateInputSchema,
  transferActionInputSchema,
  transferPreviewInputSchema,
  transferProposalInputSchema,
} from './liquidity-inputs.js';
import type { SpendSessionIntent } from './liquidity-inputs.js';
import { loadNativeBindings } from './composition.js';
import {
  InAppChannelAdapter,
  NotificationRuntime,
  NotificationRuntimeError,
} from './notifications.js';
import type { NotificationPolicy } from './notifications.js';
import { liquidityPreferenceInputSchema } from './liquidity-inputs.js';
import type { PublicLiquidityPreferences } from './liquidity-public.js';

export interface LiquidityNative {
  evaluateAccountAwareSpendability(input: string): string;
  verifyTransferPreconditions(input: string): string;
  verifyTransferSettlement(input: string): string;
}
export interface LiquidityServiceOptions {
  connectionManager: ConnectionManager;
  store: WorkflowStore;
  native: LiquidityNative;
  clock?: () => Date;
}
interface EvaluationState {
  policy: LiquidityPolicyRecord | null;
  supplemental: SupplementalFactsRecord | null;
  claimSet: LiquidityClaimSet;
  priorAllocation: { sequence: number; allocation: BackingAllocation } | null;
}
interface Capture {
  snapshot: FinancialSnapshot;
  state: EvaluationState;
  now: string;
  projector: LiquidityProjector;
  records: TransferSettlementRecord[] | null;
}

/** One trusted orchestration boundary; all financial arithmetic and transfer verification stays native. */
export class LiquidityService {
  private readonly clock: () => Date;
  constructor(private readonly options: LiquidityServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
  }
  private require(
    actor: LiquidityActor,
    kind: ResourceKind,
    id: string,
    capability: ResourceCapability,
  ): void {
    this.options.store.liquidity.requireResource({
      ...actor,
      resourceKind: kind,
      resourceId: id,
      capability,
    });
  }
  private authorizeIntent(
    actor: LiquidityActor,
    categoryId?: string,
    accountId?: string | null,
  ): void {
    const workflow = this.options.store.liquidity;
    if (workflow.isOwner(actor)) return;
    if (categoryId) {
      this.require(actor, 'category', categoryId, 'existence');
      if (
        !workflow.isAuthorized({
          ...actor,
          resourceKind: 'category',
          resourceId: categoryId,
          capability: 'conclusion',
        })
      )
        this.require(actor, 'budget', actor.budgetId, 'conclusion');
    } else this.require(actor, 'budget', actor.budgetId, 'conclusion');
    if (accountId) this.require(actor, 'account', accountId, 'existence');
  }
  private async capture<T>(
    actor: LiquidityActor,
    operation: (capture: Capture) => Promise<T>,
    raw = false,
  ): Promise<T> {
    const config = await this.options.connectionManager.loadConfig();
    if (!config || config.budgetId !== actor.budgetId)
      throw new Error('Selected budget unavailable');
    if (!this.options.store.liquidity.isOwner(actor))
      this.options.store.liquidity.loadEvaluationState({
        ...actor,
        now: this.clock().toISOString(),
      });
    return this.options.connectionManager.withConnection(async (connected) => {
      const now = this.clock().toISOString();
      const synchronization = connected.synchronization as {
        financialSnapshot?: unknown;
        transferSettlementRecords?: TransferSettlementRecord[];
      };
      const base = financialSnapshotSchema.parse(synchronization.financialSnapshot);
      if (base.source.budgetId !== actor.budgetId && base.source.ledgerId !== actor.budgetId)
        throw new Error('Selected budget unavailable');
      if (this.options.store.liquidity.isOwner(actor)) {
        const resources = [
          ...base.legacySnapshot.accounts.map((account) => ({
            resourceKind: 'account' as const,
            resourceId: account.id,
          })),
          ...base.legacySnapshot.categories.map((category) => ({
            resourceKind: 'category' as const,
            resourceId: category.id,
          })),
        ];
        const missing = resources.filter(
          (resource) =>
            !this.options.store.liquidity.isAuthorized({
              ...actor,
              ...resource,
              capability: 'existence',
            }),
        );
        if (
          missing.length ||
          !this.options.store.liquidity.isAuthorized({
            ...actor,
            resourceKind: 'budget',
            resourceId: actor.budgetId,
            capability: 'conclusion',
          })
        )
          this.options.store.liquidity.provisionOwnerAccess({ ...actor, resources: missing, now });
      }
      if (
        this.options.store.liquidity.isAuthorized({
          ...actor,
          resourceKind: 'budget',
          resourceId: actor.budgetId,
          capability: 'proposal',
        })
      )
        this.options.store.liquidity.expire({ ...actor, now });
      const state = this.options.store.liquidity.loadEvaluationState({ ...actor, now });
      let snapshot: FinancialSnapshot = base;
      if (
        !raw &&
        state.supplemental &&
        Date.parse(state.supplemental.expiresAt) > Date.parse(now)
      ) {
        const observations = state.supplemental.observations.map((observation) =>
          persistedUserAttestedLiquidityObservationSchema.parse(observation),
        );
        const valid = observations.filter((observation) => {
          if (Date.parse(observation.expiresAt) <= Date.parse(now)) return false;
          try {
            mergeUserAttestedLiquidityObservations(base, [observation]);
            return true;
          } catch (error) {
            if (
              error instanceof Error &&
              /does not match account ledger material|references an unknown account|cannot replace ledger evidence/.test(
                error.message,
              )
            )
              return false;
            throw error;
          }
        });
        snapshot = mergeUserAttestedLiquidityObservations(base, valid);
      }
      let collectionReceipts = 0;
      let collectionComplete = false;
      for (const observation of base.observations)
        if (
          observation.kind === 'account_collection_coverage' &&
          observation.scope.kind === 'global'
        ) {
          collectionReceipts += 1;
          collectionComplete = observation.state === 'complete';
        }
      const completeAccounts =
        base.coverage.accounts === 'complete' ||
        base.coverage.accounts === 'empty' ||
        (base.coverage.accounts === 'partial' && collectionReceipts === 1 && collectionComplete);
      const completeRecords =
        completeAccounts && ['complete', 'empty'].includes(base.coverage.transactions);
      const capture: Capture = {
        snapshot,
        state,
        now,
        projector: new LiquidityProjector(this.options.store, actor, snapshot),
        records: completeRecords ? (synchronization.transferSettlementRecords ?? null) : null,
      };
      if (!raw) {
        await this.reconcileCapture(actor, capture);
        capture.state = this.options.store.liquidity.loadEvaluationState({ ...actor, now });
      }
      return operation(capture);
    });
  }
  private items(
    actor: LiquidityActor,
    capture: Capture,
    input: SpendSessionIntent['items'],
    accountId: string | null,
  ): LiquidityPurchaseItem[] {
    let preferences: PaymentPreferenceRecord[] = [];
    if (capture.projector.allowed('budget', actor.budgetId, 'liquidity'))
      preferences = this.options.store.liquidity.getPaymentPreferences({
        ...actor,
        now: capture.now,
      });
    return input.map((item) => {
      this.authorizeIntent(actor, item.categoryId, item.accountId ?? accountId);
      if (
        !capture.snapshot.legacySnapshot.categories.some(
          (category) => category.id === item.categoryId,
        ) ||
        ((item.accountId ?? accountId) &&
          !capture.snapshot.legacySnapshot.accounts.some(
            (account) => account.id === (item.accountId ?? accountId),
          ))
      )
        throw new Error('Resource authorization denied');
      const preference = preferences
        .filter((value) => value.categoryId === item.categoryId)
        .sort((left, right) => left.id.localeCompare(right.id))[0];
      const historical = capture.snapshot.legacySnapshot.transactions
        .filter(
          (transaction) =>
            transaction.categoryId === item.categoryId &&
            transaction.date <= item.purchaseAt.slice(0, 10) &&
            !transaction.transferAccountId &&
            capture.projector.allowed('category', item.categoryId, 'history') &&
            capture.projector.allowed(
              'account',
              transaction.accountId,
              'history',
              'existence',
              'liquidity',
            ),
        )
        .sort(
          (left, right) => right.date.localeCompare(left.date) || left.id.localeCompare(right.id),
        )[0];
      return {
        id: item.id,
        categoryId: item.categoryId,
        amount: item.amount,
        purchaseAt: item.purchaseAt,
        requiredBy: item.requiredBy,
        routeSelection: {
          explicitAccountId: item.accountId,
          sessionAccountId: accountId,
          approvedPreference: preference?.route ?? null,
          historicalRoute: historical
            ? { accountId: historical.accountId, referenceId: historical.id }
            : null,
        },
      };
    });
  }
  private input(
    capture: Capture,
    scenario: LiquidityScenario,
    expiresAt?: string,
    horizonAnchor = capture.now,
  ): AccountAwareSpendabilityRequest | null {
    if (!capture.state.policy) return null;
    const nativePolicy = { ...capture.state.policy.policy };
    delete nativePolicy.reservationMode;
    const policy = liquidityPolicySchema.parse(nativePolicy);
    const dates = [
      horizonAnchor,
      new Date(Date.parse(horizonAnchor) + 30 * 86400000).toISOString(),
    ];
    if (scenario.kind === 'purchases')
      for (const item of scenario.items) dates.push(item.purchaseAt, item.requiredBy);
    for (const account of capture.snapshot.liquidity?.accounts ?? [])
      if (account.credit) dates.push(account.credit.dueAt);
    const starts = [
      horizonAnchor,
      ...(scenario.kind === 'purchases' ? scenario.items.map((item) => item.purchaseAt) : []),
    ];
    const horizon = {
      startsAt: starts.sort()[0]!,
      endsAt: new Date(Date.parse(dates.sort().at(-1)!) + 1).toISOString(),
    };
    const validUntil = [
      policy.expiresAt,
      new Date(Date.parse(capture.now) + 15 * 60000).toISOString(),
      ...(expiresAt ? [expiresAt] : []),
    ].sort()[0]!;
    return {
      financialSnapshot: capture.snapshot,
      context: {
        evaluatedAt: capture.now,
        horizon,
        policy: {
          pendingMode: 'includeConservatively',
          uncategorizedMode: 'block',
          unclearedMode: 'include',
          maxBankSyncAgeMinutes: 15,
          maxBudgetSnapshotAgeMinutes: 15,
          accountOverrides: { includeOnly: null, exclude: [] },
        },
        policyVersion: policy.version,
        policyHash: policy.policyHash,
        snapshotId: capture.snapshot.snapshotId,
        contentHash: capture.snapshot.contentHash,
      },
      liquidityPolicy: policy,
      claimSet: capture.state.claimSet,
      priorAllocation: capture.state.priorAllocation?.allocation ?? null,
      scenario,
      validUntil,
    };
  }
  private evaluate(
    capture: Capture,
    scenario: LiquidityScenario,
    expiresAt?: string,
  ): {
    input: AccountAwareSpendabilityRequest | null;
    result: AccountAwareSpendabilityResult | null;
    view: PublicLiquidityView;
  } {
    const input = this.input(capture, scenario, expiresAt);
    const result = input
      ? accountAwareSpendabilityResultSchema.parse(
          JSON.parse(this.options.native.evaluateAccountAwareSpendability(JSON.stringify(input))),
        )
      : null;
    return {
      input,
      result,
      view: capture.projector.view(
        input,
        result,
        capture.now,
        scenario.kind === 'purchases' ? scenario.items : [],
      ),
    };
  }
  private validator(
    capture: Capture,
    scenario: LiquidityScenario,
    original?: TransferPlan,
    sessionVersion?: number,
  ) {
    return (context: ClaimValidationContext): { valid: boolean; reason?: string } => {
      if (sessionVersion !== undefined && context.session?.version !== sessionVersion)
        return { valid: false, reason: 'session_version_conflict' };
      const freshCapture = {
        ...capture,
        state: { ...capture.state, policy: context.policy, claimSet: context.claimSet },
        now: context.now,
      };
      const currentScenario: LiquidityScenario =
        scenario.kind === 'purchases'
          ? {
              kind: 'purchases',
              items: scenario.items.map(
                (item) =>
                  this.items(
                    capture.projector.actor,
                    freshCapture,
                    [
                      {
                        id: item.id,
                        categoryId: item.categoryId,
                        amount: item.amount,
                        purchaseAt: item.purchaseAt,
                        requiredBy: item.requiredBy,
                        accountId: item.routeSelection.explicitAccountId,
                      },
                    ],
                    item.routeSelection.sessionAccountId,
                  )[0]!,
              ),
            }
          : scenario;
      const plan = original ?? context.plan;
      const current = this.input(
        freshCapture,
        currentScenario,
        plan?.expiresAt ?? context.session?.expiresAt,
        plan?.evaluatedAt ?? freshCapture.now,
      );
      if (!current) return { valid: false, reason: 'liquidity_policy_required' };
      if (plan) {
        const result = transferPreconditionResultSchema.parse(
          JSON.parse(
            this.options.native.verifyTransferPreconditions(
              JSON.stringify({ plan, currentInput: current, ownClaimId: context.ownClaimId }),
            ),
          ),
        );
        return { valid: result.valid, reason: result.reasons.join(',') };
      }
      // Unreserved sessions may intentionally contain unfunded items; evaluation is joint advice, not admission.
      accountAwareSpendabilityResultSchema.parse(
        JSON.parse(this.options.native.evaluateAccountAwareSpendability(JSON.stringify(current))),
      );
      return { valid: true };
    };
  }
  async spendability(actor: LiquidityActor): Promise<PublicLiquidityView> {
    this.authorizeIntent(actor);
    return this.capture(actor, async (capture) => {
      const evaluated = this.evaluate(capture, { kind: 'none' });
      if (
        evaluated.result?.backingAfter.feasible &&
        capture.projector.allowed('budget', actor.budgetId, 'liquidity')
      )
        this.options.store.liquidity.savePriorAllocation({
          ...actor,
          expectedSequence: capture.state.priorAllocation?.sequence ?? 0,
          allocation: evaluated.result.backingAfter,
          now: capture.now,
        });
      return evaluated.view;
    });
  }
  async evaluatePurchase(
    actor: LiquidityActor,
    value: unknown,
  ): Promise<PurchaseEvaluationResult & { liquidity: PublicLiquidityView }> {
    const intent = liquidityPurchaseInputSchema.parse(value);
    this.authorizeIntent(actor, intent.categoryId, intent.accountId);
    return this.capture(actor, async (capture) => {
      const items = this.items(
        actor,
        capture,
        [
          {
            id: 'purchase',
            categoryId: intent.categoryId,
            amount: intent.amount,
            purchaseAt: intent.purchaseAt ?? capture.now,
            requiredBy: intent.requiredBy ?? intent.purchaseAt ?? capture.now,
            accountId: intent.accountId ?? null,
          },
        ],
        null,
      );
      const { view } = this.evaluate(capture, { kind: 'purchases', items });
      const purchase = view.purchases[0];
      const funding = purchase?.fundingStatus;
      const payment = purchase?.paymentStatus;
      const allowable = funding === 'funded' && payment === 'ready';
      const verdict =
        funding === 'unfunded' || payment === 'not_liquid'
          ? 'not_safe'
          : funding !== 'funded' || payment === 'insufficient_data' || !purchase?.selectedAccountId
            ? 'insufficient_data'
            : allowable
              ? 'safe'
              : 'safe_with_qualifications';
      const category = view.categories.find((item) => item.id === intent.categoryId);
      return {
        allowable,
        reasonCodes: purchase?.reasons ?? [],
        categoryBudget: category?.availabilityBefore ?? null,
        categorySpent: null,
        categoryRemaining: category?.availabilityAfter ?? null,
        projectedBalance: null,
        hasEnvelope: funding === 'funded' || funding === 'unfunded',
        verdict,
        explanation: allowable
          ? 'The category is funded and the selected account is ready.'
          : 'Budget funding and payment-account readiness are separate. Review the account result before spending.',
        envelopeFundingState:
          funding === 'funded' ? 'funded' : funding === 'unfunded' ? 'unfunded' : 'unavailable',
        liquidity: view,
      };
    });
  }
  async previewReallocation(actor: LiquidityActor, value: unknown): Promise<PublicLiquidityView> {
    const intent = liquidityReallocationInputSchema.parse(value);
    for (const move of intent.moves) {
      this.authorizeIntent(actor, move.sourceCategoryId);
      this.authorizeIntent(actor, move.destinationCategoryId);
    }
    return this.capture(
      actor,
      async (capture) => this.evaluate(capture, { kind: 'reallocation', moves: intent.moves }).view,
    );
  }
  async configuration(actor: LiquidityActor): Promise<PublicLiquidityConfiguration> {
    if (!this.options.store.liquidity.isOwner(actor))
      this.require(actor, 'budget', actor.budgetId, 'policy');
    return this.capture(actor, async (capture) => this.configurationProjection(capture), true);
  }
  /** Actual row references are global; bank import identifiers belong to the outer account. */
  private readableObservations(
    capture: Capture,
    observations: readonly PublicUserAttestedObservation[],
  ): PublicUserAttestedObservation[] {
    let history: { rows: Map<string, boolean>; imports: Map<string, Set<string>> } | undefined;
    const referenceReadable = (id: string, accountId: string, allowBankId: boolean): boolean => {
      if (!history) {
        const index = { rows: new Map<string, boolean>(), imports: new Map<string, Set<string>>() };
        const accounts = new Map<string, boolean>();
        const scan = (transactions: FinancialSnapshot['legacySnapshot']['transactions']): void => {
          for (const transaction of transactions) {
            let readable = accounts.get(transaction.accountId);
            if (readable === undefined) {
              readable = capture.projector.allowed(
                'account',
                transaction.accountId,
                'existence',
                'history',
              );
              accounts.set(transaction.accountId, readable);
            }
            index.rows.set(transaction.id, (index.rows.get(transaction.id) ?? true) && readable);
            if (transaction.importedId !== null) {
              let identifiers = index.imports.get(transaction.accountId);
              if (!identifiers) {
                identifiers = new Set<string>();
                index.imports.set(transaction.accountId, identifiers);
              }
              identifiers.add(transaction.importedId);
            }
            scan(transaction.subtransactions);
          }
        };
        scan(capture.snapshot.legacySnapshot.transactions);
        history = index;
      }
      return (
        (allowBankId && history.imports.get(accountId)?.has(id) === true) ||
        history.rows.get(id) === true
      );
    };
    const categoryReadable = (id: string) =>
      capture.projector.allowed('category', id, 'existence', 'balance', 'history', 'liquidity');
    return observations.filter(
      (observation) =>
        capture.projector.allowed(
          'account',
          observation.accountId,
          'existence',
          'policy',
          'balance',
          'history',
          'liquidity',
        ) &&
        (observation.obligations ?? []).every(
          (obligation) =>
            (obligation.categoryId === null || categoryReadable(obligation.categoryId)) &&
            obligation.matchedTransactionIds.every((id) =>
              referenceReadable(id, observation.accountId, true),
            ),
        ) &&
        (!observation.credit ||
          (capture.projector.allowed(
            'account',
            observation.credit.paymentAccountId,
            'existence',
            'policy',
            'balance',
            'history',
            'liquidity',
          ) &&
            categoryReadable(observation.credit.paymentCategoryId))) &&
        (observation.unsettledFlows ?? []).every(
          (flow) =>
            flow.matchedTransactionIds.every((id) =>
              referenceReadable(id, observation.accountId, true),
            ) &&
            (flow.transferTransactionId === null ||
              referenceReadable(flow.transferTransactionId, observation.accountId, false)),
        ),
    );
  }
  private configurationProjection(capture: Capture): PublicLiquidityConfiguration {
    const view = this.evaluate(capture, { kind: 'none' }).view;
    const accountReadable = (id: string) =>
      capture.projector.allowed(
        'account',
        id,
        'existence',
        'policy',
        'balance',
        'history',
        'liquidity',
      );
    const categoryReadable = (id: string) =>
      capture.projector.allowed('category', id, 'existence', 'balance', 'history', 'liquidity');
    const observations: PublicUserAttestedObservation[] = this.readableObservations(
      capture,
      (capture.state.supplemental?.observations ?? []).map((observation) =>
        persistedUserAttestedLiquidityObservationSchema.parse(observation),
      ),
    ).map((observation) => ({
      accountId: observation.accountId,
      currentLedgerConfirmed: observation.currentLedgerConfirmed,
      currency: observation.currency,
      kind: observation.kind,
      owned: observation.owned,
      holds: observation.holds,
      unsettledFlows: observation.unsettledFlows?.map((flow) => ({
        id: flow.id,
        economicObligationId: flow.economicObligationId,
        direction: flow.direction,
        amount: flow.amount,
        includedInBalance: flow.includedInBalance,
        matchedTransactionIds: flow.matchedTransactionIds,
        scheduleId: flow.scheduleId,
        transferTransactionId: flow.transferTransactionId,
        importedId: flow.importedId,
        reconciled: flow.reconciled,
        provenance: flow.provenance,
      })),
      obligations: observation.obligations?.map((obligation) => ({
        id: obligation.id,
        economicObligationId: obligation.economicObligationId,
        categoryId: obligation.categoryId,
        amount: obligation.amount,
        dueAt: obligation.dueAt,
        paid: obligation.paid,
        includedInBalance: obligation.includedInBalance,
        matchedTransactionIds: obligation.matchedTransactionIds,
      })),
      credit: observation.credit
        ? {
            authorizationAvailable: observation.credit.authorizationAvailable,
            pendingIncludedInAuthorization: observation.credit.pendingIncludedInAuthorization,
            paymentAccountId: observation.credit.paymentAccountId,
            paymentCategoryId: observation.credit.paymentCategoryId,
            dueAt: observation.credit.dueAt,
            reservedCash: observation.credit.reservedCash,
            economicObligationId: observation.credit.economicObligationId,
          }
        : observation.credit,
    }));
    const fullConfiguration =
      this.options.store.liquidity.isOwner(capture.projector.actor) &&
      (capture.state.policy?.policy.accounts ?? []).every(
        (account) =>
          accountReadable(account.accountId) && account.eligibleCategoryIds.every(categoryReadable),
      ) &&
      (capture.state.policy?.policy.transferRoutes ?? []).every(
        (route) =>
          accountReadable(route.sourceAccountId) && accountReadable(route.destinationAccountId),
      );
    return {
      policy: fullConfiguration ? (capture.state.policy?.policy ?? null) : null,
      approvalPolicy: fullConfiguration ? (capture.state.policy?.approvalPolicy ?? null) : null,
      observationVersion: capture.state.supplemental?.version ?? 0,
      observations,
      observationsExpiresAt: capture.state.supplemental?.expiresAt ?? null,
      accounts: view.accounts,
      categories: view.categories,
      canConfigure: view.canConfigure,
    };
  }
  async savePolicy(actor: LiquidityActor, value: unknown): Promise<PublicLiquidityConfiguration> {
    const intent = liquidityPolicyInputSchema.parse(value);
    if (!this.options.store.liquidity.isOwner(actor))
      this.require(actor, 'budget', actor.budgetId, 'policy');
    return this.capture(
      actor,
      async (capture) => {
        this.future(intent.expiresAt, capture.now, 366 * 86400000);
        for (const account of [
          ...(capture.state.policy?.policy.accounts ?? []),
          ...intent.accounts,
        ]) {
          this.require(actor, 'account', account.accountId, 'policy');
          for (const categoryId of account.eligibleCategoryIds)
            this.require(actor, 'category', categoryId, 'policy');
        }
        for (const route of [
          ...(capture.state.policy?.policy.transferRoutes ?? []),
          ...intent.transferRoutes,
        ]) {
          this.require(actor, 'account', route.sourceAccountId, 'policy');
          this.require(actor, 'account', route.destinationAccountId, 'policy');
        }
        const version = randomUUID();
        const policy: LiquidityPolicy = {
          version,
          policyHash: '',
          expiresAt: intent.expiresAt,
          accounts: intent.accounts.map((account) => ({
            ...account,
            resourceScope: account.accountId,
          })),
          transferRoutes: intent.transferRoutes.map((route) => ({
            ...route,
            evidence: {
              state: 'known',
              source: 'user_attested',
              observedAt: capture.now,
              expiresAt: intent.expiresAt,
              reasons: ['owner_attested_transfer_timing'],
            },
          })),
        };
        policy.policyHash = `sha256:${createHash('sha256').update(canonical(policy)).digest('hex')}`;
        this.options.store.liquidity.savePolicy({
          ...actor,
          expectedVersion: intent.expectedVersion,
          policy,
          approvalPolicy: intent.approvalPolicy,
          now: capture.now,
        });
        capture.state = this.options.store.liquidity.loadEvaluationState({
          ...actor,
          now: capture.now,
        });
        return this.configurationProjection(capture);
      },
      true,
    );
  }
  async saveObservations(
    actor: LiquidityActor,
    value: unknown,
  ): Promise<PublicLiquidityConfiguration> {
    const intent = liquidityObservationInputSchema.parse(value);
    if (!this.options.store.liquidity.isOwner(actor))
      this.require(actor, 'budget', actor.budgetId, 'policy');
    for (const observation of intent.observations)
      if (!this.options.store.liquidity.isOwner(actor))
        this.require(actor, 'account', observation.accountId, 'policy');
    return this.capture(
      actor,
      async (capture) => {
        this.future(intent.expiresAt, capture.now, 24 * 3600000);
        const affected = [
          ...(capture.state.supplemental?.observations ?? []),
          ...intent.observations,
        ];
        if (this.readableObservations(capture, affected).length !== affected.length)
          throw new Error('Observation resource or history authorization denied');
        for (const observation of affected) {
          this.require(actor, 'account', observation.accountId, 'policy');
          for (const obligation of observation.obligations ?? [])
            if (obligation.categoryId !== null)
              this.require(actor, 'category', obligation.categoryId, 'policy');
          if (observation.credit) {
            this.require(actor, 'account', observation.credit.paymentAccountId, 'policy');
            this.require(actor, 'category', observation.credit.paymentCategoryId, 'policy');
          }
        }
        const observations = bindUserAttestedLiquidityObservations(
          capture.snapshot,
          intent.observations.map((observation) => ({
            ...observation,
            observedAt: capture.now,
            expiresAt: intent.expiresAt,
          })),
        );
        this.options.store.liquidity.saveSupplementalFacts({
          ...actor,
          expectedVersion: intent.expectedVersion,
          observations,
          expiresAt: intent.expiresAt,
          now: capture.now,
        });
        capture.snapshot = mergeUserAttestedLiquidityObservations(capture.snapshot, observations);
        capture.projector = new LiquidityProjector(this.options.store, actor, capture.snapshot);
        capture.state = this.options.store.liquidity.loadEvaluationState({
          ...actor,
          now: capture.now,
        });
        return this.configurationProjection(capture);
      },
      true,
    );
  }
  private future(expiresAt: string, now: string, maximum: number): void {
    const interval = Date.parse(expiresAt) - Date.parse(now);
    if (interval <= 0 || interval > maximum)
      throw new Error('Invalid expiry; choose a future time within the allowed horizon');
  }
  async grants(actor: LiquidityActor): Promise<PublicLiquidityGrants> {
    if (!this.options.store.liquidity.isOwner(actor)) throw new Error('Owner authorization denied');
    return this.capture(
      actor,
      async (capture) => ({
        ...this.options.store.liquidity.getResourceGrantCatalog(actor),
        capabilities: [...liquidityCapabilities],
        resources: [
          { resourceKind: 'budget', resourceId: actor.budgetId },
          ...capture.snapshot.legacySnapshot.accounts.map((account) => ({
            resourceKind: 'account' as const,
            resourceId: account.id,
            name: account.name,
          })),
          ...capture.snapshot.legacySnapshot.categories.map((category) => ({
            resourceKind: 'category' as const,
            resourceId: category.id,
            name: category.name,
          })),
        ],
      }),
      true,
    );
  }
  async saveGrants(actor: LiquidityActor, value: unknown): Promise<PublicLiquidityGrants> {
    const intent = liquidityGrantInputSchema.parse(value);
    if (!this.options.store.liquidity.isOwner(actor)) throw new Error('Owner authorization denied');
    const catalog = await this.grants(actor);
    for (const grant of intent.grants)
      if (
        !catalog.members.some((member) => member.actorId === grant.actorId) ||
        !catalog.resources.some(
          (resource) =>
            resource.resourceKind === grant.resourceKind &&
            resource.resourceId === grant.resourceId,
        )
      )
        throw new Error('Resource authorization denied');
    const now = this.clock().toISOString();
    for (const grant of intent.grants)
      this.options.store.liquidity.manageResourceGrant({
        ...grant,
        budgetId: actor.budgetId,
        managerId: actor.actorId,
        now,
      });
    return this.grants(actor);
  }
  async preferences(actor: LiquidityActor): Promise<PublicLiquidityPreferences> {
    this.authorizeIntent(actor);
    return this.capture(actor, async (capture) => {
      if (!capture.projector.allowed('budget', actor.budgetId, 'liquidity'))
        return { items: [], canManage: false };
      const preferences = this.options.store.liquidity.getPaymentPreferences({
        ...actor,
        now: capture.now,
        includeExpired: true,
      });
      return {
        items: preferences
          .filter(
            (preference) =>
              capture.projector.allowed('category', preference.categoryId, 'existence') &&
              capture.projector.allowed('account', preference.route.accountId, 'existence'),
          )
          .map((preference) => ({
            id: preference.id,
            version: preference.version,
            categoryId: preference.categoryId,
            accountId: preference.route.accountId,
            expiresAt: preference.expiresAt,
          })),
        canManage: capture.projector.allowed('budget', actor.budgetId, 'approval'),
      };
    });
  }
  async savePreference(actor: LiquidityActor, value: unknown): Promise<PublicLiquidityPreferences> {
    const intent = liquidityPreferenceInputSchema.parse(value);
    this.authorizeIntent(actor, intent.categoryId, intent.accountId);
    this.require(actor, 'budget', actor.budgetId, 'approval');
    await this.capture(actor, async (capture) => {
      this.future(intent.expiresAt, capture.now, 366 * 86400000);
      this.require(actor, 'category', intent.categoryId, 'category');
      this.require(actor, 'account', intent.accountId, 'liquidity');
      const id = `preference:${createHash('sha256')
        .update(canonical([actor.actorId, actor.budgetId, intent.categoryId]))
        .digest('hex')}`;
      this.options.store.liquidity.savePaymentPreference({
        ...actor,
        ...intent,
        id,
        now: capture.now,
      });
    });
    return this.preferences(actor);
  }
  async saveSession(
    actor: LiquidityActor,
    id: string | null,
    value: unknown,
  ): Promise<PublicSpendSession> {
    const intent = id
      ? spendSessionUpdateInputSchema.parse(value)
      : { ...spendSessionInputSchema.parse(value), expectedVersion: 0 };
    this.require(actor, 'budget', actor.budgetId, 'session');
    for (const item of intent.items)
      this.authorizeIntent(actor, item.categoryId, item.accountId ?? intent.accountId);
    return this.capture(actor, async (capture) => {
      this.future(intent.expiresAt, capture.now, 30 * 86400000);
      const items = this.items(actor, capture, intent.items, intent.accountId);
      const scenario = { kind: 'purchases' as const, items };
      const session = this.options.store.liquidity.saveSpendSession(
        {
          ...actor,
          id: id ?? randomUUID(),
          expectedVersion: intent.expectedVersion,
          idempotencyKey: randomUUID(),
          now: capture.now,
          expiresAt: intent.expiresAt,
          accountId: intent.accountId,
          items,
        },
        this.validator(capture, scenario),
      );
      return this.sessionProjection(actor, capture, session);
    });
  }
  async session(actor: LiquidityActor, id: string): Promise<PublicSpendSession> {
    this.require(actor, 'budget', actor.budgetId, 'session');
    return this.capture(actor, async (capture) => {
      const session = this.options.store.liquidity.getSpendSession({
        ...actor,
        id,
        now: capture.now,
      });
      if (!session) throw new Error('Session unavailable');
      return this.sessionProjection(actor, capture, session);
    });
  }
  private sessionProjection(
    actor: LiquidityActor,
    capture: Capture,
    session: SpendSession,
  ): PublicSpendSession {
    const items = this.items(
      actor,
      capture,
      session.items.map((item) => ({
        id: item.id,
        categoryId: item.categoryId,
        amount: item.amount,
        purchaseAt: item.purchaseAt,
        requiredBy: item.requiredBy,
        accountId: item.routeSelection.explicitAccountId,
      })),
      session.accountId,
    );
    const evaluation = this.evaluate(capture, { kind: 'purchases', items }, session.expiresAt).view;
    const linkedTransfers = capture.projector.allowed('budget', actor.budgetId, 'proposal')
      ? this.options.store.liquidity
          .listTransferProposals(actor)
          .filter((proposal) => proposal.payload.sessionId === session.id)
          .map((proposal) => ({
            id: proposal.id,
            phase: proposal.state.phase,
            outcome: proposal.state.outcome,
          }))
      : [];
    return {
      id: session.id,
      version: session.version,
      accountId: session.accountId,
      expiresAt: session.expiresAt,
      createdAt: session.createdAt,
      items: session.items.map((item) => ({
        id: item.id,
        categoryId: item.categoryId,
        amount: item.amount,
        purchaseAt: item.purchaseAt,
        requiredBy: item.requiredBy,
        accountId: item.routeSelection.explicitAccountId,
      })),
      evaluation,
      canEdit:
        session.actorId === actor.actorId &&
        Date.parse(session.expiresAt) > Date.parse(capture.now),
      linkedTransfers,
    };
  }
  async cancelSession(
    actor: LiquidityActor,
    id: string,
    value: unknown,
  ): Promise<{ id: string; version: number; cancelled: true }> {
    const intent = spendSessionCancelInputSchema.parse(value);
    const session = this.options.store.liquidity.cancelSpendSession({
      ...actor,
      id,
      ...intent,
      now: this.clock().toISOString(),
    });
    return { id: session.id, version: session.version, cancelled: true };
  }
  async previewTransfer(actor: LiquidityActor, value: unknown): Promise<PublicTransferPreview> {
    const intent = transferPreviewInputSchema.parse(value);
    if (intent.kind === 'purchase')
      this.authorizeIntent(actor, intent.categoryId, intent.accountId);
    else this.require(actor, 'budget', actor.budgetId, 'session');
    return this.capture(actor, async (capture) => {
      let session: SpendSession | null = null;
      let items: LiquidityPurchaseItem[];
      let itemId = 'purchase';
      if (intent.kind === 'session') {
        session = this.options.store.liquidity.getSpendSession({
          ...actor,
          id: intent.sessionId,
          now: capture.now,
        });
        if (!session || session.version !== intent.expectedSessionVersion)
          throw new Error('Session version conflict');
        items = this.items(
          actor,
          capture,
          session.items.map((item) => ({
            id: item.id,
            categoryId: item.categoryId,
            amount: item.amount,
            purchaseAt: item.purchaseAt,
            requiredBy: item.requiredBy,
            accountId: item.routeSelection.explicitAccountId,
          })),
          session.accountId,
        );
        itemId = intent.purchaseItemId;
      } else
        items = this.items(
          actor,
          capture,
          [
            {
              id: itemId,
              categoryId: intent.categoryId,
              amount: intent.amount,
              purchaseAt: intent.purchaseAt,
              requiredBy: intent.requiredBy ?? intent.purchaseAt,
              accountId: intent.accountId ?? null,
            },
          ],
          null,
        );
      const evaluatedAt = Date.parse(capture.now);
      if (items.some((item) => Date.parse(item.purchaseAt) <= evaluatedAt))
        throw new Error(
          'Invalid input: schedule every transfer-backed purchase strictly in the future',
        );
      const evaluated = this.evaluate(capture, { kind: 'purchases', items }, session?.expiresAt);
      const plan = evaluated.result?.purchases.find(
        (purchase) => purchase.itemId === itemId,
      )?.transferPlan;
      if (!plan)
        throw new Error('Transfer unavailable; refresh payment readiness and required evidence');
      const projected = capture.projector.transferPlan(plan);
      const preview = this.options.store.liquidity.saveTransferPreview({
        ...actor,
        plan,
        now: capture.now,
        ...(session ? { sessionId: session.id, sessionVersion: session.version } : {}),
      });
      return { previewId: preview.id, payloadHash: plan.payloadHash, plan: projected };
    });
  }
  async proposeTransfer(actor: LiquidityActor, value: unknown): Promise<PublicTransferDetail> {
    const intent = transferProposalInputSchema.parse(value);
    const preview = this.options.store.liquidity.getTransferPreview({
      ...actor,
      id: intent.previewId,
    });
    if (!preview || preview.plan.payloadHash !== intent.payloadHash)
      throw new Error('Preview unavailable or changed; refresh transfer preview');
    return this.capture(actor, async (capture) => {
      capture.projector.transferPlan(preview.plan);
      const proposal = this.options.store.liquidity.admitTransferProposal(
        {
          ...actor,
          plan: preview.plan,
          expectedClaimSetRevision: capture.state.claimSet.revision,
          idempotencyKey: intent.idempotencyKey,
          now: capture.now,
          ...(preview.sessionId ? { sessionId: preview.sessionId } : {}),
        },
        this.validator(
          capture,
          preview.plan.scenario,
          preview.plan,
          preview.sessionVersion ?? undefined,
        ),
      );
      return this.transferProjection(actor, capture, proposal);
    });
  }
  async transfer(actor: LiquidityActor, id: string): Promise<PublicTransferDetail> {
    this.options.store.liquidity.getTransferProposal({ ...actor, proposalId: id });
    return this.capture(actor, async (capture) =>
      this.transferProjection(
        actor,
        capture,
        this.options.store.liquidity.getTransferProposal({ ...actor, proposalId: id }),
      ),
    );
  }
  private async transferProjection(
    actor: LiquidityActor,
    capture: Capture,
    proposal: TransferProposal,
  ): Promise<PublicTransferDetail> {
    const plan = proposal.payload.plan;
    const visible = capture.projector.planAuthorized(plan);
    const { requiredApprovals, approvalCount, actorHasApproved } =
      this.options.store.liquidity.getTransferApprovalSummary({
        ...actor,
        proposalId: proposal.id,
        now: capture.now,
      });
    const live =
      Date.parse(proposal.expiresAt) > Date.parse(capture.now) &&
      !proposal.supersededAt &&
      !proposal.state.outcome;
    const instructions =
      visible &&
      live &&
      proposal.state.phase === 'approved' &&
      approvalCount >= requiredApprovals &&
      capture.projector.planAuthorized(plan, 'initiation-report');
    return {
      id: proposal.id,
      version: proposal.version,
      ...(visible ? { payloadHash: proposal.payloadHash } : {}),
      phase: proposal.state.phase,
      sourceObserved: proposal.state.sourceObserved,
      destinationObserved: proposal.state.destinationObserved,
      reconciled: proposal.state.reconciled,
      outcome: proposal.state.outcome,
      requiredApprovals,
      approvalCount,
      plan: visible ? capture.projector.transferPlan(plan) : null,
      conclusion: capture.projector.transferConclusion(plan),
      canApprove:
        visible &&
        live &&
        ['proposed', 'awaiting_approval', 'approved'].includes(proposal.state.phase) &&
        !actorHasApproved &&
        capture.projector.planAuthorized(plan, 'approval'),
      canGetInstructions: instructions,
      canReportInitiated: instructions,
      canReconcile:
        visible &&
        proposal.state.phase === 'initiated' &&
        capture.projector.planAuthorized(plan, 'confirmation'),
      canCancel:
        visible &&
        !['confirmed', 'closed'].includes(proposal.state.phase) &&
        capture.projector.planAuthorized(plan, 'proposal'),
      instructionsAvailable: instructions,
      reasons: [
        'manual_transfer_only',
        'acknowledgement_is_not_settlement',
        ...(proposal.state.outcome ? [proposal.state.outcome] : []),
      ],
    };
  }
  async transferAction(
    actor: LiquidityActor,
    id: string,
    action: string,
    value: unknown,
  ): Promise<PublicTransferDetail> {
    const intent = transferActionInputSchema.parse(value);
    const current = this.options.store.liquidity.getTransferProposal({ ...actor, proposalId: id });
    return this.capture(
      actor,
      async (capture) => {
        const command = {
          ...actor,
          proposalId: id,
          ...intent,
          now: capture.now,
          expectedClaimSetRevision: capture.state.claimSet.revision,
        };
        const validator = this.validator(capture, current.payload.plan.scenario);
        let proposal: TransferProposal;
        if (action === 'reconcile' && capture.records === null)
          throw new Error(
            'Transfer evidence unavailable; synchronize complete account history before reconciliation',
          );
        if (action === 'instructions') {
          const rechecked = this.options.store.liquidity.revalidateTransfer(
            { ...command, idempotencyKey: `revalidate:${action}:${intent.idempotencyKey}` },
            validator,
          );
          await this.finding(actor, rechecked);
          if (rechecked.state.outcome) return this.transferProjection(actor, capture, rechecked);
          command.expectedVersion = rechecked.version;
        }
        switch (action) {
          case 'approve':
            proposal = this.options.store.liquidity.approveTransfer(command, validator);
            break;
          case 'instructions':
            this.options.store.liquidity.getTransferInstructions(command, validator);
            proposal = this.options.store.liquidity.getTransferProposal({
              ...actor,
              proposalId: id,
            });
            break;
          case 'report-initiated':
            proposal = this.options.store.liquidity.reportTransferInitiated(command, validator);
            break;
          case 'reconcile':
            proposal = this.options.store.liquidity.verifyTransferSettlement(command, (context) =>
              transferSettlementResultSchema.parse(
                JSON.parse(
                  this.options.native.verifyTransferSettlement(
                    JSON.stringify({
                      plan: context.plan,
                      evaluatedAt: context.evaluatedAt,
                      consumedEvidenceIds: context.consumedEvidenceIds,
                      records: capture.records,
                    }),
                  ),
                ),
              ),
            );
            break;
          case 'cancel':
            proposal = this.options.store.liquidity.cancelTransfer(command);
            break;
          default:
            throw new Error('Unsupported transfer action');
        }
        if (action === 'report-initiated') {
          await this.reconcileCapture(actor, capture);
          proposal = this.options.store.liquidity.getTransferProposal({ ...actor, proposalId: id });
        }
        await this.finding(actor, proposal);
        return this.transferProjection(actor, capture, proposal);
      },
      action === 'reconcile' || action === 'cancel',
    );
  }
  async reconcileActive(actor: LiquidityActor): Promise<void> {
    if (
      !this.options.store.liquidity.isAuthorized({
        ...actor,
        resourceKind: 'budget',
        resourceId: actor.budgetId,
        capability: 'conclusion',
      })
    )
      return;
    await this.capture(actor, async (capture) => this.reconcileCapture(actor, capture), true);
  }
  private async reconcileCapture(actor: LiquidityActor, capture: Capture): Promise<void> {
    if (
      capture.records === null ||
      !capture.projector.allowed('budget', actor.budgetId, 'proposal', 'confirmation')
    )
      return;
    const proposals = this.options.store.liquidity.listTransferProposals(actor);
    for (const proposal of proposals) {
      if (
        proposal.state.phase !== 'initiated' ||
        !capture.projector.planAuthorized(proposal.payload.plan, 'confirmation')
      )
        continue;
      const updated = this.options.store.liquidity.verifyTransferSettlement(
        {
          ...actor,
          proposalId: proposal.id,
          payloadHash: proposal.payloadHash,
          expectedVersion: proposal.version,
          idempotencyKey: `sync:${proposal.id}:${proposal.version}:${capture.snapshot.contentHash}`,
          now: capture.now,
        },
        (context) =>
          transferSettlementResultSchema.parse(
            JSON.parse(
              this.options.native.verifyTransferSettlement(
                JSON.stringify({
                  plan: context.plan,
                  evaluatedAt: context.evaluatedAt,
                  consumedEvidenceIds: context.consumedEvidenceIds,
                  records: capture.records,
                }),
              ),
            ),
          ),
      );
      await this.finding(actor, updated);
    }
  }
  private async finding(actor: LiquidityActor, proposal: TransferProposal): Promise<void> {
    const findings = await this.options.store.listFindings({
      budgetId: actor.budgetId,
      classification: 'transfer_needs_attention',
    });
    const existing = findings.find((finding) => finding.evidence.transferId === proposal.id);
    if (proposal.state.phase === 'confirmed' || proposal.state.phase === 'closed') {
      if (existing && ['open', 'acknowledged', 'reopened'].includes(existing.status))
        await this.options.store.correctFinding({
          findingId: existing.id,
          actorId: actor.actorId,
          correctionRef: proposal.id,
          expectedVersion: existing.version,
        });
    } else if (proposal.state.outcome) {
      const finding =
        existing ??
        (await this.options.store.createFinding({
          budgetId: actor.budgetId,
          classification: 'transfer_needs_attention',
          description: 'A transfer needs authorized review. An acknowledgement is not settlement.',
          evidence: { transferId: proposal.id },
          evidenceRefs: [],
          severity: 'medium',
          actorId: proposal.actorId,
        }));
      const savedPolicy = await this.options.store.getNotificationPolicy(
        actor.budgetId,
        'notification',
      );
      if (!savedPolicy) return;
      const policy = JSON.parse(savedPolicy.policy) as NotificationPolicy;
      const runtime = new NotificationRuntime(this.options.store, policy, [
        new InAppChannelAdapter(),
      ]);
      runtime.setReAuthorizationHook(async (recipientId, capability, scope) => {
        const member = await this.options.store.getActorMembership(recipientId);
        if (
          !member ||
          member.status !== 'active' ||
          !member.capabilities.includes(capability) ||
          (member.scope !== '*' && member.scope !== scope)
        )
          return false;
        try {
          this.options.store.liquidity.getTransferProposal({
            actorId: recipientId,
            budgetId: actor.budgetId,
            proposalId: proposal.id,
          });
          return true;
        } catch {
          return false;
        }
      });
      const rule = policy.eligibility.find((rule) =>
        rule.classifications.includes('transfer_needs_attention'),
      );
      if (!rule) return;
      for (const recipient of policy.recipients) {
        try {
          await runtime.create({
            budgetId: actor.budgetId,
            classification: 'transfer_needs_attention',
            severity: 'normal',
            recipientId: recipient.actorId,
            scope: rule.requiredScope,
            correlationId: `liquidity-finding:${finding.id}`,
            dedupKey: `transfer-finding:${finding.id}:${finding.version}:${recipient.actorId}`,
            redactionClass: 'restricted',
            payload: {
              title: 'A transfer needs authorized review',
              summary: 'Open your authorized attention view. An acknowledgement is not settlement.',
            },
          });
        } catch (error) {
          if (
            !(error instanceof NotificationRuntimeError) ||
            !['NOT_ELIGIBLE', 'NOT_AUTHORIZED', 'RECIPIENT_MISMATCH', 'SCOPE_MISMATCH'].includes(
              error.code,
            )
          )
            throw error;
        }
      }
    }
  }
  async attention(actor: LiquidityActor): Promise<
    {
      transferId: string;
      classification: 'transfer_needs_attention';
      message: string;
      severity: 'warning';
      dedupKey: string;
      reasonCodes: string[];
    }[]
  > {
    await this.reconcileActive(actor);
    if (
      !this.options.store.liquidity.isAuthorized({
        ...actor,
        resourceKind: 'budget',
        resourceId: actor.budgetId,
        capability: 'proposal',
      })
    )
      return [];
    return this.options.store.liquidity
      .listTransferProposals(actor)
      .filter(
        (proposal) =>
          proposal.state.outcome && !['confirmed', 'closed'].includes(proposal.state.phase),
      )
      .map((proposal) => ({
        transferId: proposal.id,
        classification: 'transfer_needs_attention',
        message: 'A transfer needs authorized review. Acknowledgement is not settlement.',
        severity: 'warning',
        dedupKey: `transfer:${proposal.id}`,
        reasonCodes: [proposal.state.outcome!],
      }));
  }
}

/** Canonical configuration identity only; financial/plan identities are exclusively native. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** Production composition reuses the existing lazy native loader and caller's connection/store. */
export async function createLiquidityService(
  options: Omit<LiquidityServiceOptions, 'native'>,
): Promise<LiquidityService> {
  const native = await loadNativeBindings();
  if (
    !native.evaluateAccountAwareSpendability ||
    !native.verifyTransferPreconditions ||
    !native.verifyTransferSettlement
  )
    throw new Error('Native liquidity capabilities unavailable');
  return new LiquidityService({
    ...options,
    native: {
      evaluateAccountAwareSpendability: native.evaluateAccountAwareSpendability,
      verifyTransferPreconditions: native.verifyTransferPreconditions,
      verifyTransferSettlement: native.verifyTransferSettlement,
    },
  });
}
