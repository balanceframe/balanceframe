import { createHash, randomUUID } from 'node:crypto';
import type { ConnectionManager, ConnectedBudget } from './connection-manager.js';
import type {
  WorkflowStore,
  LiquidityActor,
  ClaimValidationContext,
  SpendSession,
  SessionCompletionPayload,
  SessionCompletionProposalView,
  SessionCompletionReconciliation,
  TransferProposal,
  ResourceCapability,
  ResourceKind,
  LiquidityPolicyRecord,
  GovernedLiquidityPolicy,
  SupplementalFactsRecord,
  PaymentPreferenceRecord,
  StoredProspectiveClaim,
} from '@balanceframe/workflow-store';
import type {
  AccountAwareSpendabilityRequest,
  AccountAwareSpendabilityResult,
  FinancialSnapshot,
  DecisionCard,
  DecisionCardItem,
  DecisionCardRequest,
  LiquidityPurchaseItem,
  LiquidityScenario,
  TransferPlan,
  TransferSettlementRecord,
  LiquidityClaimSet,
  LiquidityClaimBundle,
  BackingAllocation,
} from '@balanceframe/protocol-generated';
import {
  decisionCardRequestSchema,
  decisionCardSchema,
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
import type { ManualTransactionInput, ManualTransactionResult } from '@balanceframe/actual-adapter';
import type {
  PublicDecisionCard,
  PublicLiquidityConfiguration,
  PublicLiquidityGrants,
  PublicLiquidityView,
  PublicSpendSession,
  PublicTransferDetail,
  PublicSessionCompletion,
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
  prospectiveClaimInputSchema,
  prospectiveClaimReleaseInputSchema,
  sessionCompletionProposalInputSchema,
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
  evaluateDecisionCard(input: string): string;
  evaluateAccountAwareSpendability(input: string): string;
  verifyTransferPreconditions(input: string): string;
  verifyTransferSettlement(input: string): string;
}
export interface LiquidityServiceOptions {
  connectionManager: ConnectionManager;
  mutationConnectionManager?: ConnectionManager;
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
    operation: (capture: Capture, connected: ConnectedBudget) => Promise<T>,
    raw = false,
    manager: ConnectionManager = this.options.connectionManager,
  ): Promise<T> {
    const config = await manager.loadConfig();
    if (!config || config.budgetId !== actor.budgetId)
      throw new Error('Selected budget unavailable');
    if (!this.options.store.liquidity.isOwner(actor))
      this.options.store.liquidity.loadEvaluationState({
        ...actor,
        now: this.clock().toISOString(),
      });
    return manager.withConnection(async (connected) => {
      if (connected.config.budgetId !== actor.budgetId)
        throw new Error('Selected budget unavailable');
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
      return operation(capture, connected);
    }, { dispose: manager !== this.options.connectionManager });
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
    delete nativePolicy.categoryPolicies;
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
  private nativeDecisionCard(
    capture: Capture,
    items: DecisionCardItem[],
    expiresAt?: string,
    cart?: Pick<SpendSession, 'adjustments' | 'warningThresholds'>,
  ): DecisionCard | null {
    const input = this.input(capture, { kind: 'purchases', items }, expiresAt);
    if (!input) return null;
    const configured = new Map(
      (capture.state.policy?.policy.categoryPolicies ?? []).map((policy) => [
        policy.categoryId,
        policy,
      ]),
    );
    const seen = new Set<string>();
    const categoryPolicies: DecisionCardRequest['categoryPolicies'] = [];
    for (const category of capture.snapshot.liquidity?.categories ?? []) {
      if (seen.has(category.categoryId)) continue;
      seen.add(category.categoryId);
      const configuredPolicy = configured.get(category.categoryId);
      if (configuredPolicy) {
        const { cooldownMinutes: _cooldown, ...nativePolicy } = configuredPolicy;
        categoryPolicies.push(nativePolicy);
      } else {
        categoryPolicies.push({
          categoryId: category.categoryId,
          kind: 'ordinary',
          donorEligible: false,
          minimumRetained: { minorUnits: '0', currency: category.availability.currency },
          projectedRemainingNeed: {
            minorUnits: '0',
            currency: category.availability.currency,
          },
        });
      }
    }
    const request = decisionCardRequestSchema.parse({
      financialSnapshot: input.financialSnapshot,
      context: input.context,
      liquidityPolicy: input.liquidityPolicy,
      claimSet: input.claimSet,
      priorAllocation: input.priorAllocation,
      items,
      ...(cart?.adjustments ? { adjustments: cart.adjustments } : {}),
      ...(cart?.warningThresholds ? { warningThresholds: cart.warningThresholds } : {}),
      categoryPolicies,
      validUntil: input.validUntil,
      requestId: randomUUID(),
      correlationId: randomUUID(),
      decisionId: randomUUID(),
    } satisfies DecisionCardRequest);
    return decisionCardSchema.parse(
      JSON.parse(this.options.native.evaluateDecisionCard(JSON.stringify(request))) as unknown,
    );
  }
  private decisionCard(
    capture: Capture,
    items: DecisionCardItem[],
    expiresAt?: string,
    cart?: Pick<SpendSession, 'adjustments' | 'warningThresholds'>,
  ): PublicDecisionCard {
    const card = this.nativeDecisionCard(capture, items, expiresAt, cart);
    return card
      ? capture.projector.card(card)
      : {
          outcome: 'insufficient_data',
          budgetFundingStatus: 'insufficient_data',
          paymentLiquidityStatus: 'insufficient_data',
          selectedAccountId: null,
          before: null,
          after: null,
          fundingPaths: [],
          evidence: [],
          blockers: ['policy_unavailable'],
          cart: null,
          warnings: [],
          trimAlternatives: [],
        };
  }

  /** Evaluates a quick purchase through the same immutable Card as an active cart. */
  async evaluatePurchase(
    actor: LiquidityActor,
    value: unknown,
  ): Promise<{ card: PublicDecisionCard }> {
    const intent = liquidityPurchaseInputSchema.parse(value);
    this.authorizeIntent(actor, intent.categoryId, intent.accountId);
    return this.capture(actor, async (capture) => {
      const [item] = this.items(
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
      if (!item) throw new Error('Purchase item unavailable');
      return { card: this.decisionCard(capture, [{ ...item, priority: 'planned' }]) };
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
      ) &&
      (capture.state.policy?.policy.categoryPolicies ?? []).every((policy) =>
        categoryReadable(policy.categoryId),
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
        const categoryPolicies =
          intent.categoryPolicies ?? capture.state.policy?.policy.categoryPolicies ?? [];
        const seen = new Set<string>();
        for (const categoryPolicy of [
          ...(capture.state.policy?.policy.categoryPolicies ?? []),
          ...categoryPolicies,
        ]) {
          this.require(actor, 'category', categoryPolicy.categoryId, 'policy');
          if (
            !capture.snapshot.legacySnapshot.categories.some(
              ({ id }) => id === categoryPolicy.categoryId,
            )
          ) throw new Error('Unknown policy category');
        }
        for (const categoryPolicy of categoryPolicies) {
          if (seen.has(categoryPolicy.categoryId)) throw new Error('Duplicate policy category');
          seen.add(categoryPolicy.categoryId);
          const category = capture.snapshot.liquidity?.categories.find(
            ({ categoryId }) => categoryId === categoryPolicy.categoryId,
          );
          if (
            !category ||
            categoryPolicy.minimumRetained.currency !== category.availability.currency ||
            categoryPolicy.projectedRemainingNeed.currency !== category.availability.currency
          ) throw new Error('Category policy currency or evidence unavailable');
        }
        const version = randomUUID();
        const policy: GovernedLiquidityPolicy = {
          version,
          policyHash: '',
          expiresAt: intent.expiresAt,
          reservationMode: intent.reservationMode ??
            capture.state.policy?.policy.reservationMode ?? 'inform',
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
          categoryPolicies,
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
    for (const item of intent.items) {
      this.authorizeIntent(actor, item.categoryId, item.accountId ?? intent.accountId);
      for (const allocation of item.categoryAllocations ?? [])
        this.require(actor, 'category', allocation.categoryId, 'category');
    }
    for (const adjustment of intent.adjustments ?? [])
      this.require(actor, 'category', adjustment.categoryId, 'category');
    for (const threshold of intent.warningThresholds ?? [])
      if (threshold.basis === 'category_charge')
        this.require(actor, 'category', threshold.categoryId, 'category');
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
          items: intent.items,
          ...(intent.adjustments ? { adjustments: intent.adjustments } : {}),
          ...(intent.warningThresholds ? { warningThresholds: intent.warningThresholds } : {}),
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
  private sessionItems(actor: LiquidityActor, capture: Capture, session: SpendSession): DecisionCardItem[] {
    const routes = this.items(actor, capture, session.items, session.accountId);
    return session.items.map((item, index) => {
      const route = routes[index];
      if (!route) throw new Error('Session route unavailable');
      const immediate = item.purchaseAt < capture.now &&
        item.purchaseAt.slice(0, 10) === capture.now.slice(0, 10) &&
        item.requiredBy <= item.purchaseAt;
      return {
        ...route,
        ...(immediate ? { purchaseAt: capture.now, requiredBy: capture.now } : {}),
        priority: item.priority ?? 'planned',
        ...(item.quantity === undefined ? {} : { quantity: item.quantity }),
        ...(item.categoryAllocations ? { categoryAllocations: item.categoryAllocations } : {}),
        ...(item.priceProvenance ? { priceProvenance: item.priceProvenance } : {}),
        ...(item.barcode ? { barcode: item.barcode } : {}),
      };
    });
  }
  private sessionProjection(
    actor: LiquidityActor,
    capture: Capture,
    session: SpendSession,
  ): PublicSpendSession {
    const items = this.sessionItems(actor, capture, session);
    const card = this.decisionCard(capture, items, session.expiresAt, session);
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
        accountId: item.accountId,
        ...(item.quantity === undefined ? {} : { quantity: item.quantity }),
        ...(item.priority === undefined ? {} : { priority: item.priority }),
        ...(item.categoryAllocations ? { categoryAllocations: item.categoryAllocations } : {}),
        priceProvenance: item.priceProvenance ?? null,
        ...(item.barcode ? { barcode: item.barcode } : {}),
      })),
      adjustments: session.adjustments ?? [],
      warningThresholds: session.warningThresholds ?? [],
      card,
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
  /** Admits a scoped commitment or reservation from a current native-funded cart charge. */
  async createProspectiveClaim(
    actor: LiquidityActor,
    value: unknown,
  ): Promise<StoredProspectiveClaim> {
    const intent = prospectiveClaimInputSchema.parse(value);
    this.require(actor, 'budget', actor.budgetId, 'liquidity');
    this.require(actor, intent.scope.kind, intent.scope.id,
      intent.scope.kind === 'category' ? 'category' : 'liquidity');
    return this.capture(actor, async (capture) => {
      const replay = this.options.store.liquidity.replayProspectiveClaim({
        ...actor,
        sourceId: `session:${intent.sessionId}:${intent.expectedSessionVersion}`,
        kind: intent.kind, scope: intent.scope,
        idempotencyKey: intent.idempotencyKey, now: capture.now,
      });
      if (replay) return replay;
      const session = this.options.store.liquidity.getSpendSession({
        ...actor, id: intent.sessionId, now: capture.now,
      });
      if (!session || session.version !== intent.expectedSessionVersion)
        throw new Error('Session version conflict');
      const current = this.withoutSessionProspectiveClaims(actor, capture, session);
      const items = this.sessionItems(actor, current, session);
      const card = this.nativeDecisionCard(current, items, session.expiresAt, session);
      if (!card || card.outcome !== 'funded_now' || !card.cart)
        throw new Error('Current funded Card required for a reservation or commitment');
      const charge = intent.scope.kind === 'category'
        ? card.cart.categoryCharges.find((entry) => entry.categoryId === intent.scope.id)
        : card.cart.accountCharges.find((entry) => entry.accountId === intent.scope.id);
      if (!charge) throw new Error('Claim scope is not charged by the current cart');
      const policy = capture.state.policy;
      if (!policy) throw new Error('Liquidity policy unavailable');
      const claimId = randomUUID();
      const sourceId = `session:${session.id}:${session.version}`;
      return this.options.store.liquidity.saveProspectiveClaim({
        ...actor,
        claim: {
          claimId,
          kind: intent.kind,
          sourceId,
          scope: intent.scope,
          amount: charge.amount,
          status: 'active',
          effectiveFrom: capture.now,
          expiresAt: session.expiresAt,
          visibility: 'visible',
          policyVersion: policy.policy.version,
          snapshotId: capture.snapshot.snapshotId,
        },
        expectedClaimSetRevision: capture.state.claimSet.revision,
        idempotencyKey: intent.idempotencyKey,
        now: capture.now,
      }, (context) => {
        const freshSession = this.options.store.liquidity.getSpendSession({
          ...actor, id: session.id, now: context.now,
        });
        if (!freshSession || freshSession.version !== session.version ||
            context.policy.policy.version !== policy.policy.version ||
            context.proposedClaim?.effects[0]?.amount.minorUnits !== charge.amount.minorUnits)
          return { valid: false, reason: 'Claim source or policy changed' };
        const current = this.withoutSessionProspectiveClaims(actor, {
          ...capture,
          now: context.now,
          state: { ...capture.state, policy: context.policy, claimSet: context.claimSet },
        }, freshSession);
        const reevaluated = this.nativeDecisionCard(
          current, this.sessionItems(actor, current, session), session.expiresAt, session,
        );
        return reevaluated?.outcome === 'funded_now' &&
          canonical(reevaluated.cart) === canonical(card.cart)
          ? { valid: true }
          : { valid: false, reason: 'Claim would reuse unavailable cart funds' };
      });
    });
  }
  /** Lists visible and redacted BalanceFrame-side claims without inventing ledger transactions. */
  async prospectiveClaims(actor: LiquidityActor): Promise<StoredProspectiveClaim[]> {
    this.require(actor, 'budget', actor.budgetId, 'liquidity');
    return this.capture(actor, async (capture) =>
      this.options.store.liquidity.listProspectiveClaims({ ...actor, now: capture.now }));
  }
  /** Releases only a still-active claim under the current shared claim-set revision. */
  async releaseProspectiveClaim(
    actor: LiquidityActor,
    claimId: string,
    value: unknown,
  ): Promise<StoredProspectiveClaim> {
    const intent = prospectiveClaimReleaseInputSchema.parse(value);
    return this.capture(actor, async (capture) =>
      this.options.store.liquidity.transitionProspectiveClaim({
        ...actor,
        claimId,
        transition: 'release',
        expectedClaimSetRevision: capture.state.claimSet.revision,
        idempotencyKey: intent.idempotencyKey,
        now: capture.now,
      }));
  }
  private withoutSessionProspectiveClaims(
    actor: LiquidityActor,
    capture: Capture,
    session: SpendSession,
    ownClaimId: string | null = null,
  ): Capture {
    const sourceId = `session:${session.id}:${session.version}`;
    const originatingClaims = new Set(this.options.store.liquidity
      .listProspectiveClaims({ ...actor, now: capture.now })
      .filter((claim) => claim.sourceId === sourceId && claim.lifecycleState === 'active')
      .map((claim) => claim.claimId));
    return {
      ...capture,
      state: {
        ...capture.state,
        claimSet: {
          ...capture.state.claimSet,
          bundles: capture.state.claimSet.bundles.filter(
            (bundle) => bundle.id !== ownClaimId && !originatingClaims.has(bundle.id),
          ),
        },
      },
    };
  }

  private completionCard(
    actor: LiquidityActor,
    capture: Capture,
    session: SpendSession,
    ownClaimId: string | null = null,
  ): { card: DecisionCard; intentHash: string; materialHash: string } {
    const current = this.withoutSessionProspectiveClaims(actor, capture, session, ownClaimId);
    const intentHash = createHash('sha256').update(canonical({
      kind: 'session_completion_intent_v1',
      id: session.id,
      version: session.version,
      accountId: session.accountId,
      items: session.items,
      adjustments: session.adjustments ?? [],
      warningThresholds: session.warningThresholds ?? [],
    })).digest('hex');
    const items = this.sessionItems(actor, current, session).map((item) => {
      if (Date.parse(item.requiredBy) > Date.parse(item.purchaseAt))
        throw new Error('Session completion requires a valid purchase deadline');
      if (item.purchaseAt >= current.now) return item;
      if (item.purchaseAt.slice(0, 7) !== current.now.slice(0, 7))
        throw new Error('Session completion requires the current budget month');
      return { ...item, purchaseAt: current.now, requiredBy: current.now };
    });
    const card = this.nativeDecisionCard(current, items, session.expiresAt, session);
    if (!card || card.outcome !== 'funded_now' || card.readiness.status !== 'evaluated' ||
        !card.cart || card.cart.accountCharges.length !== 1)
      throw new Error('Session completion unavailable: current Card is not funded now');
    const material = {
      snapshot: stableLedgerMaterial(current.snapshot),
      policy: current.state.policy?.policy ?? null,
      supplementalVersion: current.state.supplemental?.version ?? null,
      supplementalExpiry: current.state.supplemental?.expiresAt ?? null,
      claims: current.state.claimSet.bundles,
      sessionId: session.id,
      sessionVersion: session.version,
      sessionExpiresAt: session.expiresAt,
      intentHash,
      outcome: card.outcome,
      selectedAccountId: card.selectedAccountId,
      cart: card.cart,
      fundingPaths: card.fundingPaths.map(stableLedgerMaterial),
    };
    return {
      card,
      intentHash,
      materialHash: createHash('sha256').update(canonical(material)).digest('hex'),
    };
  }
  private completionValidator(
    actor: LiquidityActor,
    capture: Capture,
    payload: SessionCompletionPayload,
  ) {
    return (context: ClaimValidationContext): { valid: boolean; reason?: string } => {
      if (!context.session || context.session.id !== payload.sessionId ||
          context.session.version !== payload.sessionVersion)
        return { valid: false, reason: 'Session version changed' };
      try {
        const owner = { actorId: context.session.actorId, budgetId: actor.budgetId };
        const freshCapture: Capture = {
          ...capture,
          projector: new LiquidityProjector(this.options.store, owner, capture.snapshot),
          now: context.now,
          state: { ...capture.state, policy: context.policy, claimSet: context.claimSet },
        };
        const { card, intentHash, materialHash } = this.completionCard(
          owner, freshCapture, context.session, context.ownClaimId,
        );
        if (intentHash !== payload.intentHash || materialHash !== payload.materialHash ||
            canonical(card.cart?.categoryCharges) !== canonical(payload.categoryCharges) ||
            card.cart?.accountCharges[0]?.accountId !== payload.manualInput.accountId ||
            card.cart?.total.minorUnits !== String(-payload.manualInput.amount))
          return { valid: false, reason: 'Session completion Card or ledger changed' };
        return { valid: true };
      } catch {
        return { valid: false, reason: 'Current funded Card unavailable' };
      }
    };
  }
  /** Admits a saved cart only when the current native Card proves its exact immediate funding. */
  async proposeSessionCompletion(
    actor: LiquidityActor,
    sessionId: string,
    value: unknown,
  ): Promise<PublicSessionCompletion> {
    const intent = sessionCompletionProposalInputSchema.parse(value);
    this.require(actor, 'budget', actor.budgetId, 'proposal');
    return this.capture(actor, async (capture) => {
      const replay = this.options.store.liquidity.replaySessionCompletion({
        ...actor, sessionId, expectedSessionVersion: intent.expectedSessionVersion,
        payeeName: intent.payeeName, notes: intent.notes,
        idempotencyKey: intent.idempotencyKey, now: capture.now,
      });
      if (replay) return this.completionProjection(actor, capture, replay);
      const session = this.options.store.liquidity.getSpendSession({
        ...actor, id: sessionId, now: capture.now,
      });
      if (!session || session.version !== intent.expectedSessionVersion)
        throw new Error('Session version conflict');
      const { card, intentHash, materialHash } = this.completionCard(actor, capture, session);
      const cart = card.cart!;
      const date = session.items[0]?.purchaseAt.slice(0, 10);
      if (!date || date > capture.now.slice(0, 10) ||
          session.items.some((item) => item.purchaseAt.slice(0, 10) !== date))
        throw new Error('Session completion requires one present or past purchase date');
      const account = cart.accountCharges[0]!;
      if (account.amount.minorUnits !== cart.total.minorUnits ||
          account.amount.currency !== cart.total.currency)
        throw new Error('Session completion requires one payment account');
      const amount = Number(cart.total.minorUnits);
      if (!Number.isSafeInteger(amount) || amount <= 0)
        throw new Error('Session completion amount exceeds exact Actual integer range');
      let splitTotal = 0n;
      const splits = cart.categoryCharges.map((charge) => {
        if (charge.amount.currency !== cart.total!.currency)
          throw new Error('Session completion category currency mismatch');
        const minorUnits = Number(charge.amount.minorUnits);
        if (!Number.isSafeInteger(minorUnits) || minorUnits <= 0)
          throw new Error('Session completion split exceeds exact Actual integer range');
        splitTotal += BigInt(charge.amount.minorUnits);
        this.require(actor, 'category', charge.categoryId, 'proposal');
        return { categoryId: charge.categoryId, accountId: account.accountId,
          date, amount: -minorUnits };
      });
      if (splitTotal !== BigInt(cart.total.minorUnits))
        throw new Error('Session completion split does not conserve native total');
      this.require(actor, 'account', account.accountId, 'proposal');
      const policy = capture.state.policy;
      if (!policy) throw new Error('Session completion policy unavailable');
      const minutes = Math.max(0, ...cart.categoryCharges.map((charge) => {
        const rule = policy.policy.categoryPolicies?.find(
          (candidate) => candidate.categoryId === charge.categoryId,
        );
        return rule?.kind === 'discretionary' ? rule.cooldownMinutes ?? 0 : 0;
      }));
      const cooldownUntil = minutes > 0
        ? new Date(Date.parse(capture.now) + minutes * 60_000).toISOString() : null;
      if (cooldownUntil && cooldownUntil >= session.expiresAt)
        throw new Error('Session expires before discretionary cooldown ends');
      const parentId = randomUUID();
      const payload: SessionCompletionPayload = {
        kind: 'session_completion',
        sessionId: session.id,
        sessionVersion: session.version,
        intentHash,
        materialHash,
        manualInput: {
          parentId,
          correlationId: randomUUID(),
          accountId: account.accountId,
          amount: -amount,
          date,
          ...(splits.length === 1 ? { categoryId: splits[0]!.categoryId } : { splits }),
          ...(intent.payeeName ? { payeeName: intent.payeeName } : {}),
          ...(intent.notes ? { notes: intent.notes } : {}),
        },
        categoryCharges: cart.categoryCharges,
        cooldownUntil,
      };
      const expiresAt = [session.expiresAt, policy.policy.expiresAt].sort()[0]!;
      const obligationId = `completion:${session.id}`;
      const claim: LiquidityClaimBundle = {
        id: `completion:${randomUUID()}`,
        creationSnapshotId: capture.snapshot.snapshotId,
        creationPolicyVersion: policy.policy.version,
        state: 'active',
        expiresAt,
        initiated: false,
        effects: [
          ...cart.categoryCharges.map((charge) => ({
            kind: 'category' as const,
            resourceId: charge.categoryId,
            amount: charge.amount,
            economicObligationId: `${obligationId}:category:${charge.categoryId}`,
            categoryId: charge.categoryId,
            includedInBalance: false,
            matchedTransactionIds: [],
          })),
          { kind: 'account_debit', resourceId: account.accountId, amount: cart.total,
            economicObligationId: `${obligationId}:account:${account.accountId}`, categoryId: null,
            includedInBalance: false, matchedTransactionIds: [] },
        ],
      };
      const proposal = this.options.store.liquidity.admitSessionCompletion({
        ...actor, sessionId, expectedSessionVersion: session.version,
        payload, payloadHash: createHash('sha256').update(canonical(payload)).digest('hex'),
        claim, expectedClaimSetRevision: capture.state.claimSet.revision,
        idempotencyKey: intent.idempotencyKey, now: capture.now,
      }, this.completionValidator(actor, capture, payload));
      return this.completionProjection(actor, capture, proposal);
    });
  }
  private completionProjection(
    actor: LiquidityActor,
    capture: Capture,
    proposal: SessionCompletionProposalView,
  ): PublicSessionCompletion {
    const { payload } = proposal;
    const accountId = payload.manualInput.accountId;
    const categories = payload.categoryCharges.map((charge) => charge.categoryId);
    const visible =
      capture.projector.allowed('budget', actor.budgetId, 'proposal') &&
      capture.projector.allowed('budget', actor.budgetId, 'session') &&
      capture.projector.allowed('account', accountId, 'existence', 'balance', 'liquidity', 'proposal') &&
      categories.every((id) =>
        capture.projector.allowed('category', id, 'existence', 'liquidity', 'proposal'));
    const authorized = (capability: ResourceCapability) =>
      visible &&
      capture.projector.allowed('budget', actor.budgetId, capability) &&
      capture.projector.allowed('account', accountId, capability) &&
      categories.every((id) => capture.projector.allowed('category', id, capability));
    return {
      id: proposal.id,
      version: proposal.version,
      phase: proposal.state.phase,
      outcome: proposal.state.outcome,
      expiresAt: proposal.expiresAt,
      cooldownUntil: visible ? payload.cooldownUntil : null,
      payloadHash: visible ? proposal.payloadHash : null,
      requiredApprovals: proposal.requiredApprovals,
      approvalCount: proposal.approvalCount,
      canApprove: authorized('approval') && proposal.state.phase === 'proposed' &&
        (!payload.cooldownUntil || payload.cooldownUntil <= capture.now),
      canExecute: authorized('initiation-report') && authorized('confirmation') &&
        proposal.state.phase === 'approved' &&
        (!payload.cooldownUntil || payload.cooldownUntil <= capture.now),
      debit: visible ? {
        accountId,
        amount: payload.manualInput.amount,
        date: payload.manualInput.date,
        payeeName: payload.manualInput.payeeName ?? null,
        notes: payload.manualInput.notes ?? null,
        categoryCharges: payload.categoryCharges.map((charge) => ({
          categoryId: charge.categoryId,
          amount: charge.amount,
        })),
        splits: payload.manualInput.splits?.map((split) => ({
          categoryId: split.categoryId,
          amount: split.amount,
        })) ?? [],
      } : null,
      manualTransactionId: visible ? proposal.manualTransactionId : null,
      importedTransactionId: visible ? proposal.importedTransactionId : null,
      reviewRequired: proposal.state.phase === 'review_required' ||
        proposal.state.phase === 'write_intent',
    };
  }
  /** Re-evaluates the same immutable Card before accepting a human completion approval. */
  async approveSessionCompletion(
    actor: LiquidityActor,
    proposalId: string,
    value: unknown,
  ): Promise<PublicSessionCompletion> {
    const intent = transferActionInputSchema.parse(value);
    return this.capture(actor, async (capture) => {
      const original = this.options.store.liquidity.getSessionCompletionProposal({
        ...actor, proposalId, now: capture.now,
      });
      const approved = this.options.store.liquidity.approveSessionCompletion({
        ...actor, proposalId, ...intent, now: capture.now,
        expectedClaimSetRevision: capture.state.claimSet.revision,
      }, this.completionValidator(actor, capture, original.payload));
      return this.completionProjection(actor, capture, approved);
    });
  }
  /** Reads one scoped completion and its current verified/review status. */
  async sessionCompletion(
    actor: LiquidityActor,
    proposalId: string,
  ): Promise<PublicSessionCompletion> {
    return this.capture(actor, async (capture) =>
      this.completionProjection(actor, capture,
        this.options.store.liquidity.getSessionCompletionProposal({
          ...actor, proposalId, now: capture.now,
        })),
    );
  }
  /** Lists only currently authorized session-completion proposals. */
  async sessionCompletions(
    actor: LiquidityActor,
    sessionId: string,
  ): Promise<PublicSessionCompletion[]> {
    return this.capture(actor, async (capture) =>
      this.options.store.liquidity.listSessionCompletionProposals({
        ...actor, sessionId, now: capture.now,
      }).map((proposal) => this.completionProjection(actor, capture, proposal)),
    );
  }
  /**
   * Persists a one-shot write intent before invoking the mutation-mode Actual connector.
   * A crash or uncertain response leaves the initiated claim held for manual review.
   */
  async executeSessionCompletion(
    actor: LiquidityActor,
    proposalId: string,
    value: unknown,
  ): Promise<PublicSessionCompletion> {
    const manager = this.options.mutationConnectionManager;
    if (!manager) throw new Error('Mutation connection unavailable');
    const intent = transferActionInputSchema.parse(value);
    return this.capture(actor, async (capture, connected) => {
      const writable = connected.connector as typeof connected.connector & {
        createManualTransaction?: (input: ManualTransactionInput) => Promise<ManualTransactionResult>;
      };
      if (typeof writable.createManualTransaction !== 'function')
        throw new Error('Mutation connection unavailable');
      const original = this.options.store.liquidity.getSessionCompletionProposal({
        ...actor, proposalId, now: capture.now,
      });
      if (['verified', 'review_required', 'write_intent'].includes(original.state.phase))
        return this.completionProjection(actor, capture, original);
      const started = this.options.store.liquidity.beginSessionCompletionWrite({
        ...actor, proposalId, ...intent, now: capture.now,
        expectedClaimSetRevision: capture.state.claimSet.revision,
      }, this.completionValidator(actor, capture, original.payload));
      if (!started.acquiredWriteIntent || !started.payload)
        return this.completionProjection(actor, capture, started.proposal);
      const input = started.payload.manualInput;
      let result: ManualTransactionResult;
      try {
        const { splits, ...parentInput } = input;
        result = await writable.createManualTransaction({
          ...parentInput,
          ...(splits ? { splits: splits.map((split) => ({ ...split })) } : {}),
        });
      } catch {
        result = {
          success: false, verified: false, parentId: input.parentId,
          correlationId: input.correlationId, code: 'WRITE_UNCERTAIN',
          error: 'Actual write outcome could not be verified.', reviewRequired: true,
        };
      }
      const finished = this.options.store.liquidity.finishSessionCompletionWrite({
        ...actor, proposalId, payloadHash: intent.payloadHash,
        expectedVersion: started.proposal.version,
        idempotencyKey: `finish:${intent.idempotencyKey}`, now: capture.now,
        result: result.success
          ? { success: true, verified: true, parentId: result.parentId,
              transactionId: result.transactionId }
          : { success: false, verified: false, parentId: result.parentId,
              code: result.code, reviewRequired: true },
      });
      return this.completionProjection(actor, capture, finished);
    }, false, manager);
  }
  private exactCompletionParent(
    transaction: FinancialSnapshot['legacySnapshot']['transactions'][number],
    input: SessionCompletionPayload['manualInput'],
    currency: string,
  ): boolean {
    if (transaction.id !== input.parentId ||
        transaction.accountId !== input.accountId ||
        transaction.date !== input.date ||
        transaction.amount.minorUnits !== String(input.amount) ||
        transaction.amount.currency !== currency ||
        transaction.transferAccountId !== null ||
        (input.payeeName && transaction.payeeName !== input.payeeName) ||
        (input.notes && transaction.notes !== input.notes))
      return false;
    if (!input.splits)
      return transaction.subtransactions.length === 0 &&
        transaction.categoryId === input.categoryId;
    if (transaction.categoryId !== null ||
        transaction.subtransactions.length !== input.splits.length ||
        new Set(transaction.subtransactions.map((child) => child.id)).size !== input.splits.length)
      return false;
    const observed = transaction.subtransactions.map((child) => ({
      accountId: child.accountId, date: child.date, categoryId: child.categoryId,
      amount: child.amount.minorUnits, currency: child.amount.currency,
      transferAccountId: child.transferAccountId,
    }));
    const expected = input.splits.map((split) => ({
      accountId: split.accountId, date: split.date, categoryId: split.categoryId,
      amount: String(split.amount), currency, transferAccountId: null,
    }));
    return canonical(observed.map(canonical).sort()) === canonical(expected.map(canonical).sort());
  }
  /**
   * Re-reads Actual to reconcile a durable manual parent or a later account-scoped bank import.
   * No caller can nominate or manufacture a bank ID or trigger a second ledger write.
   */
  async reconcileSessionCompletion(
    actor: LiquidityActor,
    proposalId: string,
    value: unknown,
  ): Promise<PublicSessionCompletion> {
    const intent = transferActionInputSchema.parse(value);
    return this.capture(actor, async (capture) => {
      const proposal = this.options.store.liquidity.getSessionCompletionProposal({
        ...actor, proposalId, now: capture.now,
      });
      if (proposal.payloadHash !== intent.payloadHash) throw new Error('Payload hash mismatch');
      if (proposal.version !== intent.expectedVersion) throw new Error('Proposal version conflict');
      const input = proposal.payload.manualInput;
      const currency = proposal.payload.categoryCharges[0]?.amount.currency;
      if (!currency) throw new Error('Completion currency unavailable');
      if (capture.snapshot.coverage.accounts !== 'complete' ||
          capture.snapshot.coverage.transactions !== 'complete')
        throw new Error('Complete account and transaction coverage required for reconciliation');
      const rows = capture.snapshot.legacySnapshot.transactions;
      const parents = rows.filter((row) => row.id === input.parentId);
      const candidates = rows.filter((row) =>
        row.id !== input.parentId &&
        row.accountId === input.accountId &&
        row.date === input.date &&
        row.amount.minorUnits === String(input.amount) &&
        row.amount.currency === currency &&
        row.importedId !== null,
      );
      const parent = parents.length === 1 ? parents[0] : undefined;
      const exact = parent && this.exactCompletionParent(parent, input, currency);
      let evidence: SessionCompletionReconciliation;
      if (!exact || candidates.length) {
        if (proposal.state.phase === 'verified')
          throw new Error('Ambiguous Actual reconciliation requires human review');
        const candidateIds = candidates.map((row) => `${row.accountId}:${row.id}`).sort();
        evidence = {
          evidenceId: `ambiguous:${input.accountId}:${input.parentId}:${createHash('sha256').update(canonical(candidateIds)).digest('hex')}`,
          kind: 'ambiguous', parentId: input.parentId, accountId: input.accountId,
          verified: false, reason: 'Manual parent missing, changed, or competing with an imported row',
        };
      } else if (proposal.state.phase === 'verified') {
        if (!parent.importedId || !parent.reconciled)
          return this.completionProjection(actor, capture, proposal);
        evidence = {
          evidenceId: `import:${input.accountId}:${parent.importedId}`,
          kind: 'imported_link', parentId: input.parentId,
          accountId: input.accountId, transactionId: parent.id, verified: true,
        };
      } else {
        evidence = {
          evidenceId: `manual:${input.accountId}:${input.parentId}`,
          kind: 'manual_parent', parentId: input.parentId,
          accountId: input.accountId, transactionId: parent.id, verified: true,
        };
      }
      if (proposal.reconciliation?.evidenceId === evidence.evidenceId)
        return this.completionProjection(actor, capture, proposal);
      const reconciled = this.options.store.liquidity.reconcileSessionCompletion({
        ...actor, proposalId, ...intent, now: capture.now,
        expectedClaimSetRevision: capture.state.claimSet.revision, evidence,
      });
      return this.completionProjection(actor, capture, reconciled);
    });
  }
  async previewTransfer(actor: LiquidityActor, value: unknown): Promise<PublicTransferPreview> {
    const intent = transferPreviewInputSchema.parse(value);
    if (intent.kind === 'purchase')
      this.authorizeIntent(actor, intent.categoryId, intent.accountId);
    else this.require(actor, 'budget', actor.budgetId, 'session');
    return this.capture(actor, async (capture) => {
      let session: SpendSession | null = null;
      let plan: TransferPlan | undefined;
      if (intent.kind === 'session') {
        session = this.options.store.liquidity.getSpendSession({
          ...actor,
          id: intent.sessionId,
          now: capture.now,
        });
        if (!session || session.version !== intent.expectedSessionVersion)
          throw new Error('Session version conflict');
        const items = this.sessionItems(actor, capture, session);
        if (
          !items.some((item) => item.id === intent.purchaseItemId) ||
          items.some((item) => Date.parse(item.purchaseAt) <= Date.parse(capture.now))
        )
          throw new Error('Invalid input: schedule a known session item strictly in the future');
        const card = this.nativeDecisionCard(capture, items, session.expiresAt, session);
        const path = card?.outcome === 'safe_after_date'
          ? card.fundingPaths.find(
              (candidate) =>
                candidate.kind === 'account_transfer' &&
                candidate.itemIds.some(
                  (id) =>
                    id === intent.purchaseItemId ||
                    id.startsWith(`${intent.purchaseItemId}::category-`),
                ),
            )
          : undefined;
        if (path?.kind === 'account_transfer') {
          const { kind: _kind, itemId: _itemId, itemIds: _itemIds, ...exactPlan } = path;
          plan = exactPlan;
        }
      } else {
        const itemId = 'purchase';
        const items = this.items(
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
        if (items.some((item) => Date.parse(item.purchaseAt) <= Date.parse(capture.now)))
          throw new Error(
            'Invalid input: schedule every transfer-backed purchase strictly in the future',
          );
        plan = this.evaluate(capture, { kind: 'purchases', items }).result?.purchases.find(
          (purchase) => purchase.itemId === itemId,
        )?.transferPlan ?? undefined;
      }
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

/** Stable object-key ordering for workflow identities; native Rust owns financial plan hashes. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** Ignore observation-clock metadata without ignoring ledger values or provenance state. */
const observationOnlyFields = new Set([
  'snapshotId', 'contentHash', 'capturedAt', 'snapshotDate', 'ledgerContentHash',
  'actualDownloadedAt', 'bankSyncedAt', 'observedAt', 'expiresAt',
]);
function stableLedgerMaterial(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableLedgerMaterial);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key, item]) => !observationOnlyFields.has(key) && item !== undefined)
        .map(([key, item]) => [key, stableLedgerMaterial(item)]),
    );
  return value;
}

/** Production composition reuses the existing lazy native loader and caller's connection/store. */
export async function createLiquidityService(
  options: Omit<LiquidityServiceOptions, 'native'>,
): Promise<LiquidityService> {
  const native = await loadNativeBindings();
  if (
    !native.evaluateDecisionCard ||
    !native.evaluateAccountAwareSpendability ||
    !native.verifyTransferPreconditions ||
    !native.verifyTransferSettlement
  )
    throw new Error('Native liquidity capabilities unavailable');
  return new LiquidityService({
    ...options,
    native: {
      evaluateDecisionCard: native.evaluateDecisionCard,
      evaluateAccountAwareSpendability: native.evaluateAccountAwareSpendability,
      verifyTransferPreconditions: native.verifyTransferPreconditions,
      verifyTransferSettlement: native.verifyTransferSettlement,
    },
  });
}
