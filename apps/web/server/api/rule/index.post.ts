import { createMerchantIntelligenceService, createNativeRuleMutationProtocol } from '@balanceframe/application';
import type { ConnectionConfig, RustRuleMutationProtocol } from '@balanceframe/application';
import { canonicalProtocolSnapshotSchema } from '@balanceframe/protocol-generated/validators';
import { ProposalAcquisitionError } from '@balanceframe/workflow-store';
import type { GenericActionProposal } from '@balanceframe/workflow-store';
import { defineEventHandler, readBody, setHeader, setResponseStatus } from 'h3';
import { z } from 'zod';
import { createMutationConnectionManager } from '../../utils/mutation-executor';
import { selectedLiquidityActor } from '../../utils/liquidity-service';
import { hasTrustedRequestOrigin } from '../../utils/reauthentication';
import type { ReauthenticationEvent } from '../../utils/reauthentication';
import { buildProposalApprovalView } from '../../utils/proposal-approval-view';
import { createRuleProposal, findRuleSourceTransaction, hasNativeRuleSourceAdmission } from '../../utils/rule-create';
import { requireSelectedSpace } from '../../utils/space-context';
import type { ApiEnvelope, EventWithContext } from '../../utils/workflow-store';
import {
  classifyConnectionError,
  errorEnvelope,
  getWorkflowStore,
  okEnvelope,
  requireAuthorization,
  requireProposalAuthorization,
} from '../../utils/workflow-store';

const Text = z.string().min(1).max(200).refine((value) => value.trim() === value);
const RuleCreateBody = z.object({
  operation: z.literal('create_rule').default('create_rule'),
  name: Text,
  payeeId: Text,
  categoryId: z.string().trim().min(1).max(200),
  transactionId: z.string().trim().min(1).max(200).optional(),
}).strict();

type ConnectionResult =
  | { readonly kind: 'proposal'; readonly proposal: GenericActionProposal }
  | { readonly kind: 'response'; readonly response: ApiEnvelope<null> }
  | { readonly kind: 'failure'; readonly status: number; readonly code: string; readonly message: string };

export default defineEventHandler(async (event) => {
  const requestId = crypto.randomUUID();
  setHeader(event, 'Cache-Control', 'private, no-store');
  const context = event as unknown as EventWithContext;
  if (!hasTrustedRequestOrigin(event as unknown as ReauthenticationEvent)) {
    setResponseStatus(event, 403);
    return errorEnvelope('FORBIDDEN', 'Rule proposal is unavailable.', null, false, requestId);
  }

  const selected = await requireSelectedSpace(context);
  if (!selected.ok) return selected.response;
  const budgetId = selected.space.budgetId;
  if (!budgetId) {
    setResponseStatus(event, 409);
    return errorEnvelope('SPACE_BUDGET_REQUIRED', 'The selected space has no bound budget.', null, false, requestId);
  }

  const budgetAuthorization = await requireProposalAuthorization(
    context,
    'rule:propose',
    `budget:${budgetId}`,
    'create_rule',
  );
  if (!budgetAuthorization.ok) return budgetAuthorization.response;

  const body = RuleCreateBody.safeParse(await readBody<unknown>(event).catch(() => null));
  if (!body.success) {
    setResponseStatus(event, 400);
    return errorEnvelope('INVALID_RULE_PROPOSAL', 'A rule label, exact payee ID, and category are required.', budgetAuthorization.info, false, requestId);
  }

  const categoryAuthorization = await requireProposalAuthorization(
    context,
    'rule:propose',
    `category:${body.data.categoryId}`,
    'create_rule',
  );
  if (!categoryAuthorization.ok) return categoryAuthorization.response;

  const workflow = getWorkflowStore(context);
  if ('error' in workflow) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', 'Rule proposals are unavailable.', budgetAuthorization.info, false, requestId);
  }
  const actor = selectedLiquidityActor(workflow.store, selected);
  if (!actor || !workflow.store.liquidity.isAuthorized({
    ...actor,
    resourceKind: 'category',
    resourceId: body.data.categoryId,
    capability: 'existence',
  })) {
    setResponseStatus(event, 403);
    return errorEnvelope('FORBIDDEN', 'Current target-category authorization is unavailable.', budgetAuthorization.info, false, requestId);
  }

  if (body.data.transactionId) {
    const transactionProposalAuthorization = await requireProposalAuthorization(
      context,
      'rule:propose',
      `transaction:${body.data.transactionId}`,
      'create_rule',
    );
    if (!transactionProposalAuthorization.ok) return transactionProposalAuthorization.response;
    const transactionReadAuthorization = await requireAuthorization(
      context,
      'full-read',
      `transaction:${body.data.transactionId}`,
    );
    if (!transactionReadAuthorization.ok) return transactionReadAuthorization.response;
  }

  if (!await hasNativeRuleSourceAdmission(workflow.store,actor,'rule:propose')) {
    setResponseStatus(event,403);
    return errorEnvelope('FORBIDDEN','Complete global rule and source authority is unavailable.',budgetAuthorization.info,false,requestId);
  }

  const manager = createMutationConnectionManager({
    configPath: process.env.BALANCEFRAME_CONFIG_PATH,
  });
  let config: ConnectionConfig | null;
  try {
    config = await manager.loadConfig();
  } catch {
    setResponseStatus(event, 503);
    return errorEnvelope('LEDGER_UNAVAILABLE', 'The selected budget connection is unavailable.', budgetAuthorization.info, true, requestId);
  }
  if (!config || config.budgetId !== budgetId) {
    setResponseStatus(event, 409);
    return errorEnvelope('SPACE_CONNECTION_MISMATCH', 'The configured budget does not match the selected space.', budgetAuthorization.info, false, requestId);
  }

  let native: RustRuleMutationProtocol;
  try {
    native = await createNativeRuleMutationProtocol();
  } catch {
    setResponseStatus(event, 501);
    return errorEnvelope('NATIVE_UNAVAILABLE', 'Native rule planning is unavailable.', budgetAuthorization.info, false, requestId);
  }

  let connectedResult: ConnectionResult;
  try {
    const sourceService = await createMerchantIntelligenceService({ store:workflow.store,connectionManager:manager });
    connectedResult = await manager.withConnection(async (connected): Promise<ConnectionResult> => {
      if (connected.config.budgetId !== budgetId || connected.budget.id !== budgetId)
        return { kind: 'failure', status: 409, code: 'SPACE_CONNECTION_MISMATCH', message: 'The connected budget does not match the selected space.' };

      const synchronization = await connected.connector.synchronize({ refresh:true });
      const rawSynchronization = z.object({
        snapshot:z.unknown(),rulePlanningSourceAvailability:z.unknown().optional(),
      }).passthrough().safeParse(synchronization);
      if (!rawSynchronization.success)
        return { kind: 'failure', status: 409, code: 'RULE_SNAPSHOT_UNAVAILABLE', message: 'A current SDK snapshot is unavailable.' };
      const snapshot = canonicalProtocolSnapshotSchema.safeParse(rawSynchronization.data.snapshot);
      if (!snapshot.success)
        return { kind: 'failure', status: 409, code: 'RULE_SNAPSHOT_UNAVAILABLE', message: 'A current SDK snapshot is unavailable.' };

      const categories = snapshot.data.categories.filter((category) =>
        category.id === body.data.categoryId && !category.deleted);
      if (categories.length !== 1)
        return { kind: 'failure', status: 409, code: 'CATEGORY_UNAVAILABLE', message: 'The requested current category is unavailable.' };

      let transaction: typeof snapshot.data.transactions[number] | undefined;
      if (body.data.transactionId) {
        transaction = findRuleSourceTransaction(snapshot.data,body.data.transactionId);
        if (!transaction)
          return { kind:'failure',status:409,code:'TRANSACTION_UNAVAILABLE',message:'The requested current transaction is unavailable or ambiguous.' };
        if (!transaction.payeeId)
          return { kind:'failure',status:409,code:'MERCHANT_UNAVAILABLE',message:'The current transaction has no stable payee ID.' };
        if (transaction.payeeId !== body.data.payeeId)
          return { kind:'failure',status:409,code:'MERCHANT_MISMATCH',message:'The supplied payee ID differs from the current transaction.' };

        const accounts = snapshot.data.accounts.filter((account) => account.id === transaction!.accountId);
        if (accounts.length !== 1)
          return { kind: 'failure', status: 409, code: 'TRANSACTION_UNAVAILABLE', message: 'The current transaction account is unavailable or ambiguous.' };

        const accountProposalAuthorization = await requireProposalAuthorization(
          context,
          'rule:propose',
          `account:${transaction.accountId}`,
          'create_rule',
        );
        if (!accountProposalAuthorization.ok)
          return { kind: 'response', response: accountProposalAuthorization.response };
        const accountReadAuthorization = await requireAuthorization(
          context,
          'full-read',
          `account:${transaction.accountId}`,
        );
        if (!accountReadAuthorization.ok)
          return { kind: 'response', response: accountReadAuthorization.response };

        if (transaction.categoryId && transaction.categoryId !== body.data.categoryId) {
          const currentCategoryProposalAuthorization = await requireProposalAuthorization(
            context,
            'rule:propose',
            `category:${transaction.categoryId}`,
            'create_rule',
          );
          if (!currentCategoryProposalAuthorization.ok)
            return { kind: 'response', response: currentCategoryProposalAuthorization.response };
          const currentCategoryReadAuthorization = await requireAuthorization(
            context,
            'existence',
            `category:${transaction.categoryId}`,
          );
          if (!currentCategoryReadAuthorization.ok)
            return { kind: 'response', response: currentCategoryReadAuthorization.response };
        }

      }

      const currentContext = await sourceService.getCurrentRuleReviewContext({ ...actor,spaceId:selected.space.id,auth:selected.auth }, {
        evidenceKey:null,connected,snapshot:snapshot.data,sourceAvailability:rawSynchronization.data.rulePlanningSourceAvailability,
      });
      const nativePlan = native.planCreateRule({
        name:body.data.name,conditions:[{field:'payee',op:'is',value:body.data.payeeId}],
        actions:[{op:'set',field:'category',value:body.data.categoryId}],
        budgetId,stage:'post',conditionsOp:'and',reviewContext:currentContext,
      },snapshot.data);
      const reviewedSimulation = native.simulateCreateRulePlan(nativePlan,snapshot.data);
      const proposal = await createRuleProposal({
        store:workflow.store,spaceId:selected.space.id,budgetId,actorId:selected.auth.actorId,auth:selected.auth,
        origin:{kind:'rule-route',...(transaction ? {transactionId:transaction.id} : {})},
        correlationId:requestId,expiresAt:currentContext.expiresAt,
        name:body.data.name,payeeId:body.data.payeeId,categoryId:body.data.categoryId,
        nativePlan,currentContext,reviewedSimulation,snapshot:snapshot.data,...(transaction ? {transaction} : {}),
      });
      return { kind: 'proposal', proposal };
    }, { expectedBudgetId: budgetId, dispose: true, synchronize:false });
  } catch (error) {
    if (error instanceof ProposalAcquisitionError && error.reasonCode === 'authorization_denied') {
      setResponseStatus(event, 403);
      return errorEnvelope('FORBIDDEN', 'Complete current rule proposal authority is unavailable.', budgetAuthorization.info, false, requestId);
    }
    const connectionError = classifyConnectionError(error);
    setResponseStatus(event, connectionError ? 503 : 409);
    return errorEnvelope(
      connectionError?.code ?? 'PROPOSAL_UNAVAILABLE',
      connectionError?.message ?? 'A current rule proposal could not be created.',
      budgetAuthorization.info,
      connectionError?.retryable ?? false,
      requestId,
    );
  }

  if (connectedResult.kind === 'response') return connectedResult.response;
  if (connectedResult.kind === 'failure') {
    setResponseStatus(event, connectedResult.status);
    return errorEnvelope(connectedResult.code, connectedResult.message, budgetAuthorization.info, false, requestId);
  }

  const proposalView = buildProposalApprovalView({
    store: workflow.store,
    proposal: connectedResult.proposal,
    actorId: selected.auth.actorId,
    auth: selected.auth,
    now: new Date().toISOString(),
    requestId,
  });
  if (!proposalView) {
    setResponseStatus(event, 409);
    return errorEnvelope('PROPOSAL_UNAVAILABLE', 'A current rule proposal could not be read.', budgetAuthorization.info, false, requestId);
  }
  return okEnvelope({
    proposal: proposalView,
    simulationStatus: 'present',
    simulationWarning: null,
  }, budgetAuthorization.info, requestId);
});
