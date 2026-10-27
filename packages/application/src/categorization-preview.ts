import { canonicalProposalJson, ProposalAcquisitionError } from '@balanceframe/workflow-store';
import type {
  ActionProposal,
  CategorizationExecutionPreview,
  OperationalAuth,
  WorkflowStore,
} from '@balanceframe/workflow-store';
import type { FinancialSnapshot } from '@balanceframe/protocol-generated';
import { financialSnapshotSchema } from '@balanceframe/protocol-generated/validators';
import { z } from 'zod';
import type { ConnectionManager } from './connection-manager.js';
import {
  checkCategorizationPreconditions,
  type MutationPlan,
  type RustMutationProtocol,
} from './mutation.js';
import { indexCanonicalTransactions } from './review-persistence.js';

type CategoryProposal = Extract<ActionProposal, { operation: 'set_category' }>;

/** Normal SDK lifecycle effects remain possible before, during and after this local preview. */
export const CATEGORIZATION_PREVIEW_DISCLOSURE =
  'Source acquisition uses the normal Actual SDK connection and synchronization. It may upload pending changes or archives, migrate the budget, or post configured schedules, including after shutdown. This simulation plans no categorization write. It compares bounded local observations, without atomic or server-confirmed consistency. Execute is separate and rechecks current authority and source facts.';

/** Trusted human request for a selected proposal and budget. */
export interface CategorizationPreviewInput {
  readonly proposalId: string;
  readonly actorId: string;
  readonly auth: OperationalAuth;
  readonly spaceId: string;
  readonly budgetId: string;
  readonly requestId: string;
}

/** Privacy-admitted result over bounded local observations, never execution authority. */
export interface CategorizationPreviewReport {
  readonly simulationOnly: true;
  readonly status: 'eligible_on_captured_inputs' | 'approval_required' | 'blocked';
  readonly reasonCodes: readonly string[];
  readonly proposalId: string;
  readonly payloadHash: string;
  readonly source: {
    /** Acquisition contract; a blocked report is an attempt, not a successful capture receipt. */
    readonly kind: 'locally_observed';
    readonly startedAt: string;
    readonly completedAt: string;
    readonly atomic: false;
    readonly serverConfirmed: false;
    readonly maySynchronize: true;
  };
  readonly plan: Pick<
    MutationPlan,
    'planId' | 'transactionId' | 'currentCategoryId' | 'proposedCategoryId'
  > | null;
  readonly requiredApprovers: number | null;
  readonly disclosure: string;
}

/** Safe classified failure for HTTP/CLI mappers; arbitrary source exceptions are withheld. */
export class CategorizationPreviewError extends Error {
  readonly code = 'CATEGORIZATION_PREVIEW_UNAVAILABLE';
  constructor(
    readonly reasonCode: string,
    readonly statusCode: 403 | 404,
  ) {
    super(
      statusCode === 404
        ? 'Categorization proposal unavailable'
        : 'Categorization preview authority unavailable',
    );
    this.name = 'CategorizationPreviewError';
  }
}

interface PreviewOptions {
  readonly store: WorkflowStore;
  readonly connectionManager: ConnectionManager;
  readonly protocol: RustMutationProtocol;
  readonly clock?: () => Date;
}
interface Admission {
  readonly proposal: CategoryProposal;
  readonly preflight: CategorizationExecutionPreview;
}

/** Computes a detached categorization plan after ordinary SDK source synchronization. */
export class CategorizationPreviewService {
  private readonly clock: () => Date;
  constructor(private readonly options: PreviewOptions) {
    this.clock = options.clock ?? (() => new Date());
  }

  /** Rechecks human disclosure and execution preflight without claiming or dispatching a proposal. */
  async preview(input: CategorizationPreviewInput): Promise<CategorizationPreviewReport> {
    const startedAt = this.clock().toISOString();
    let initial: Admission;
    let admitted: CategoryProposal | undefined;
    const report = (
      reasonCodes: readonly string[],
      current?: Admission,
      plan: CategorizationPreviewReport['plan'] = null,
    ): CategorizationPreviewReport => ({
      simulationOnly: true,
      status:
        reasonCodes.length && reasonCodes[0] !== 'approval_required'
          ? 'blocked'
          : current?.preflight.status === 'would_execute'
            ? 'eligible_on_captured_inputs'
            : 'approval_required',
      reasonCodes,
      proposalId: admitted!.id,
      payloadHash: admitted!.payloadHash,
      source: {
        kind: 'locally_observed',
        startedAt,
        completedAt: this.clock().toISOString(),
        atomic: false,
        serverConfirmed: false,
        maySynchronize: true,
      },
      plan,
      requiredApprovers: current?.preflight.requiredApprovers ?? null,
      disclosure: CATEGORIZATION_PREVIEW_DISCLOSURE,
    });
    try {
      admitted = this.readProposal(input);
      initial = this.preflight(input, admitted);
    } catch (error) {
      if (
        error instanceof ProposalAcquisitionError &&
        admitted &&
        error.reasonCode !== 'authorization_denied' &&
        error.reasonCode !== 'policy_version_mismatch'
      )
        return report([error.reasonCode]);
      throw this.safeError(error);
    }
    const immutableProposal = canonicalProposalJson(initial.proposal);
    let connectionIdentity: string | null = null;
    const assertCurrent = async (): Promise<void> => {
      this.readProposal(input);
      const config = await this.options.connectionManager.loadConfig();
      if (!config || config.budgetId !== input.budgetId)
        throw new CategorizationPreviewError('selected_budget_mismatch', 403);
      // Configuration reads yield; re-admit before touching any SDK lifecycle handle.
      const current = this.preflight(input, this.readProposal(input));
      const identity = canonicalProposalJson(config);
      if (connectionIdentity !== null && identity !== connectionIdentity)
        throw new CategorizationPreviewError('source_connection_changed', 403);
      connectionIdentity = identity;
      if (
        canonicalProposalJson(current.proposal) !== immutableProposal ||
        current.preflight.contextHash !== initial.preflight.contextHash
      )
        throw new PreviewBlocked('preview_context_changed');
    };
    try {
      await assertCurrent();
      return await this.options.connectionManager.withConnection(
        async (connected) => {
          if (
            connected.config.budgetId !== input.budgetId ||
            canonicalProposalJson(connected.config) !== connectionIdentity
          )
            throw new CategorizationPreviewError('selected_budget_mismatch', 403);
          await assertCurrent();
          let first: FinancialSnapshot;
          let second: FinancialSnapshot;
          try {
            const firstRead = await connected.connector.synchronize();
            await assertCurrent();
            first = capture(firstRead, input, this.clock());
            const secondRead = await connected.connector.synchronize({ refresh: false });
            await assertCurrent();
            second = capture(secondRead, input, this.clock());
          } catch (error) {
            if (
              error instanceof PreviewBlocked ||
              error instanceof CategorizationPreviewError ||
              error instanceof ProposalAcquisitionError
            )
              throw error;
            throw new PreviewBlocked('source_unavailable');
          }
          await assertCurrent();
          if (materialSource(first) !== materialSource(second))
            throw new PreviewBlocked('source_changed');
          const detached = freeze(
            structuredClone({ proposal: initial.proposal, snapshot: second }),
          );
          const plan = planDetachedCategorization(detached, {
            planSetCategory: this.options.protocol.planSetCategory.bind(this.options.protocol),
          });
          await assertCurrent();
          return report(
            initial.preflight.status === 'approval_required' ? ['approval_required'] : [],
            initial,
            plan,
          );
        },
        { expectedBudgetId: input.budgetId, synchronize: false, assertCurrent },
      );
    } catch (caught) {
      let error: unknown = caught;
      // Disclosure is a fresh boundary even for a blocked report after asynchronous I/O.
      this.readProposal(input);
      const config = await this.options.connectionManager.loadConfig();
      this.readProposal(input);
      if (
        !config ||
        config.budgetId !== input.budgetId ||
        canonicalProposalJson(config) !== connectionIdentity
      )
        throw new CategorizationPreviewError('selected_budget_mismatch', 403);
      try {
        const current = this.preflight(input, this.readProposal(input));
        if (
          canonicalProposalJson(current.proposal) !== immutableProposal ||
          current.preflight.contextHash !== initial.preflight.contextHash
        )
          error = new PreviewBlocked('preview_context_changed');
      } catch (currentError) {
        error = currentError;
      }
      if (error instanceof CategorizationPreviewError) throw error;
      if (error instanceof ProposalAcquisitionError) {
        if (
          error.reasonCode === 'authorization_denied' ||
          error.reasonCode === 'policy_version_mismatch'
        )
          throw this.safeError(error);
        return report([error.reasonCode], initial);
      }
      return report(
        [error instanceof PreviewBlocked ? error.reasonCode : 'source_unavailable'],
        initial,
      );
    }
  }

  private readProposal(input: CategorizationPreviewInput): CategoryProposal {
    const now = this.clock().toISOString();
    if (
      input.actorId !== input.auth.actorId ||
      (input.auth.method === 'api-key' && input.auth.principalType === 'agent') ||
      (input.auth.credentialExpiresAt != null &&
        (!Number.isFinite(Date.parse(input.auth.credentialExpiresAt)) ||
          Date.parse(input.auth.credentialExpiresAt) <= Date.parse(now))) ||
      (input.auth.isCredentialValid !== undefined && !input.auth.isCredentialValid(now))
    )
      throw new CategorizationPreviewError('authorization_denied', 403);
    const [read] = this.options.store.getProposalApprovalReads({
      ...input,
      proposalIds: [input.proposalId],
      privateProjection: 'detail',
      now,
    });
    if (
      !read ||
      read.proposal.operation !== 'set_category' ||
      read.proposal.budgetId !== input.budgetId ||
      read.proposal.spaceId !== input.spaceId
    )
      throw new CategorizationPreviewError('proposal_not_found', 404);
    if (!read.summary.privateEnvelopeVisible)
      throw new CategorizationPreviewError('authorization_denied', 403);
    const member = this.options.store.governance.getCurrentMembership({
      actorId: input.actorId,
      spaceId: input.spaceId,
      now,
    });
    const grant =
      member &&
      this.options.store.governance.currentResourceGrant({
        actorId: input.actorId,
        spaceId: input.spaceId,
        budgetId: input.budgetId,
        membershipId: member.id,
        capability: 'full-read',
        resourceKind: 'budget',
        resourceId: input.budgetId,
      });
    // A scoped or numerically bounded read cannot admit an as-yet-unseen whole SDK snapshot.
    if (
      !grant?.granted ||
      Object.keys(grant.restrictions).length !== 0 ||
      !this.options.store.liquidity.isAuthorized({
        ...input,
        now,
        resourceKind: 'budget',
        resourceId: input.budgetId,
        capability: 'full-read',
        visibility: 'resource',
      })
    )
      throw new CategorizationPreviewError('authorization_denied', 403);
    return freeze(structuredClone(read.proposal));
  }

  private preflight(input: CategorizationPreviewInput, proposal: CategoryProposal): Admission {
    const preflight = this.options.store.previewCategorizationExecution({
      actorId: input.actorId,
      auth: input.auth,
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      governancePolicyVersion: proposal.governancePolicyVersion!,
      idempotencyKey: `categorization-preview:${proposal.id}:${proposal.payloadHash}`,
      serialisedEffect: JSON.stringify({
        operation: proposal.operation,
        payload: proposal.payload,
        preconditions: JSON.parse(proposal.preconditions) as unknown,
      }),
      now: this.clock().toISOString(),
      requestId: input.requestId,
    });
    return { proposal, preflight };
  }

  private safeError(error: unknown): CategorizationPreviewError {
    return error instanceof CategorizationPreviewError
      ? error
      : new CategorizationPreviewError('authorization_denied', 403);
  }
}

class PreviewBlocked extends Error {
  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

function capture(value: unknown, input: CategorizationPreviewInput, now: Date): FinancialSnapshot {
  const parsed = financialSnapshotSchema.safeParse(
    value !== null && typeof value === 'object' && 'financialSnapshot' in value
      ? value.financialSnapshot
      : undefined,
  );
  if (!parsed.success) throw new PreviewBlocked('source_invalid');
  const snapshot = parsed.data;
  if (
    value !== null &&
    typeof value === 'object' &&
    'snapshot' in value &&
    canonicalProposalJson(value.snapshot) !== canonicalProposalJson(snapshot.legacySnapshot)
  )
    throw new PreviewBlocked('source_invalid');
  if (
    snapshot.source.budgetId !== input.budgetId ||
    (snapshot.source.spaceId !== null && snapshot.source.spaceId !== input.spaceId)
  )
    throw new PreviewBlocked('source_budget_mismatch');
  const date = Date.parse(snapshot.legacySnapshot.snapshotDate);
  if (
    !Number.isFinite(date) ||
    date > now.getTime() ||
    now.getTime() - date > 3_600_000 ||
    Date.parse(snapshot.capturedAt) > now.getTime() ||
    now.getTime() - Date.parse(snapshot.capturedAt) > 3_600_000
  )
    throw new PreviewBlocked('stale_snapshot');
  const accountReceipts = snapshot.observations.filter(
    (observation) =>
      observation.kind === 'account_collection_coverage' && observation.scope.kind === 'global',
  );
  const completeAccounts =
    ['complete', 'empty'].includes(snapshot.coverage.accounts) ||
    (snapshot.coverage.accounts === 'partial' &&
      accountReceipts.length === 1 &&
      accountReceipts[0]!.state === 'complete');
  if (
    !completeAccounts ||
    !['complete', 'empty'].includes(snapshot.coverage.transactions) ||
    !['complete', 'empty'].includes(snapshot.coverage.categories)
  )
    throw new PreviewBlocked('source_incomplete');
  for (const collection of [
    'accounts',
    'transactions',
    'categories',
    'payees',
    'rules',
    'schedules',
    'budgets',
    'tags',
  ] as const) {
    if (
      snapshot.coverage[collection] === 'empty' &&
      snapshot.legacySnapshot[collection].length !== 0
    )
      throw new PreviewBlocked('source_incomplete');
  }
  if (
    snapshot.inclusionScope.pendingActivity !== 'included' ||
    snapshot.inclusionScope.unclearedActivity !== 'included'
  )
    throw new PreviewBlocked('source_incomplete');
  try {
    indexCanonicalTransactions(snapshot.legacySnapshot.transactions);
  } catch {
    throw new PreviewBlocked('transaction_identity_conflict');
  }
  for (const rows of [snapshot.legacySnapshot.accounts, snapshot.legacySnapshot.categories])
    if (
      rows.some((row) => !row.id.trim()) ||
      new Set(rows.map((row) => row.id)).size !== rows.length
    )
      throw new PreviewBlocked('source_invalid');
  return snapshot;
}

function materialSource(snapshot: FinancialSnapshot): string {
  const copy = structuredClone(snapshot);
  const { snapshotId: _id, contentHash: _hash, capturedAt: _at, ...material } = copy;
  delete (material.legacySnapshot as Partial<FinancialSnapshot['legacySnapshot']>).snapshotDate;
  delete material.legacySnapshot.actualDownloadedAt;
  if (material.liquidity)
    delete (material.liquidity as Partial<NonNullable<FinancialSnapshot['liquidity']>>)
      .ledgerContentHash;
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          key === 'observedAt' && entry === snapshot.capturedAt ? 'capture_time' : normalize(entry),
        ]),
      );
    return value;
  };
  return canonicalProposalJson(normalize(material));
}

const planSchema = z.object({
  planId: z.string().min(1),
  transactionId: z.string().min(1),
  currentCategoryId: z.string().min(1).nullable(),
  proposedCategoryId: z.string().min(1),
  hash: z.string().min(1),
  postconditions: z.array(z.object({ type: z.string(), categoryId: z.string() })),
});

// The computational phase receives detached facts and a native planner, never workflow or SDK handles.
function planDetachedCategorization(
  input: { proposal: CategoryProposal; snapshot: FinancialSnapshot },
  native: Pick<RustMutationProtocol, 'planSetCategory'>,
): NonNullable<CategorizationPreviewReport['plan']> {
  const {
    proposal,
    snapshot: { legacySnapshot: snapshot },
  } = input;
  const transaction = indexCanonicalTransactions(snapshot.transactions).get(
    proposal.payload.transactionId,
  );
  if (!transaction) throw new PreviewBlocked('transaction_not_found');
  const category = snapshot.categories.find(
    (row) => row.id === proposal.payload.categoryId && !row.deleted,
  );
  if (!category) throw new PreviewBlocked('category_not_found');
  const account = snapshot.accounts.find((row) => row.id === transaction.accountId);
  if (
    !account ||
    account.isClosed ||
    account.clearedBalance.currency !== transaction.amount.currency ||
    account.importedBalance.currency !== transaction.amount.currency
  )
    throw new PreviewBlocked('precondition_mismatch');
  let plan: MutationPlan;
  try {
    plan = planSchema.parse(native.planSetCategory(transaction, category));
  } catch {
    throw new PreviewBlocked('plan_failed');
  }
  if (
    plan.transactionId !== transaction.id ||
    plan.proposedCategoryId !== category.id ||
    !checkCategorizationPreconditions(proposal, plan, transaction, snapshot).ok
  )
    throw new PreviewBlocked('precondition_mismatch');
  return {
    planId: plan.planId,
    transactionId: plan.transactionId,
    currentCategoryId: plan.currentCategoryId,
    proposedCategoryId: plan.proposedCategoryId,
  };
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  }
  return value;
}
