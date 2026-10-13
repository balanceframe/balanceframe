import { defineEventHandler, setHeader, setResponseStatus } from 'h3';
import { z } from 'zod';
import {
  CategorizationMutationService,
  RuleMutationService,
  createNativeCategorizationMutationProtocol,
  createNativeRuleMutationProtocol,
  createMerchantIntelligenceService,
  ruleReviewContextSchema,
} from '@balanceframe/application';
import type {
  RustMutationProtocol,
  ExecuteCategorizationResult,
  ExecuteRuleResult,
  RustRuleMutationProtocol,
  ResolveRuleReplayPublicationAuthority,
} from '@balanceframe/application';
import type { ConnectionConfig } from '@balanceframe/application';
import type { BudgetLedger } from '@balanceframe/actual-adapter';
import { createMutationConnectionManager } from '../../../utils/mutation-executor';
import { selectedLiquidityActor } from '../../../utils/liquidity-service';
import { hasNativeRuleSourceAdmission } from '../../../utils/rule-create';
import { hasTrustedRequestOrigin } from '../../../utils/reauthentication';
import type { ReauthenticationEvent } from '../../../utils/reauthentication';
import { requireSelectedSpace } from '../../../utils/space-context';
import { composeScenarioResearch } from '../../../utils/scenario-research';
import type { EventWithContext } from '../../../utils/workflow-store';
import {
  errorEnvelope,
  getWorkflowStore,
  okEnvelope,
  sanitizeError,
} from '../../../utils/workflow-store';

const ProposalId = z.string().trim().min(1).max(200);

type ServiceResult = ExecuteCategorizationResult | ExecuteRuleResult;

function executionError(reasonCodes: readonly string[]): {
  status: number;
  code: string;
  retryable: boolean;
} {
  if (reasonCodes.includes('approval_required'))
    return { status: 403, code: 'PROPOSAL_NOT_APPROVED', retryable: false };
  if (reasonCodes.includes('authorization_denied') || reasonCodes.includes('insufficient_capability') || reasonCodes.includes('insufficient_scope'))
    return { status: 403, code: 'FORBIDDEN', retryable: false };
  if (reasonCodes.includes('proposal_not_found'))
    return { status: 404, code: 'NOT_FOUND', retryable: false };
  if (reasonCodes.includes('proposal_expired'))
    return { status: 409, code: 'PROPOSAL_EXPIRED', retryable: false };
  if (reasonCodes.includes('proposal_superseded'))
    return { status: 409, code: 'PROPOSAL_SUPERSEDED', retryable: false };
  if (reasonCodes.includes('policy_version_mismatch'))
    return { status: 409, code: 'GOVERNANCE_CHANGED', retryable: false };
  if (reasonCodes.includes('payload_hash_mismatch'))
    return { status: 422, code: 'PROPOSAL_INVALID', retryable: false };
  if (reasonCodes.includes('idempotency_in_progress'))
    return { status: 409, code: 'EXECUTION_IN_PROGRESS', retryable: true };
  if (reasonCodes.includes('idempotency_replay_mismatch'))
    return { status: 409, code: 'EXECUTION_CONFLICT', retryable: false };
  if (reasonCodes.some((code) => ['sync_failed', 'reread_failed', 'stale_snapshot'].includes(code)))
    return { status: 503, code: 'LEDGER_SYNC_FAILED', retryable: true };
  if (reasonCodes.some((code) => ['rule_name_conflict','precondition_mismatch','simulation_conflicts','simulation_no_matches','simulation_mismatch','invalid_preconditions','plan_mismatch'].includes(code)))
    return { status: 409, code: 'PRECONDITION_FAILED', retryable: false };
  return { status: 500, code: 'EXECUTION_FAILED', retryable: true };
}

export default defineEventHandler(async (event) => {
  const requestId = crypto.randomUUID();
  setHeader(event, 'Cache-Control', 'private, no-store');
  if (!hasTrustedRequestOrigin(event as unknown as ReauthenticationEvent)) {
    setResponseStatus(event, 403);
    return errorEnvelope('FORBIDDEN', 'Proposal execution is unavailable.', null, false, requestId);
  }

  const selected = await requireSelectedSpace(event as unknown as EventWithContext);
  if (!selected.ok) return selected.response;
  if (!selected.space.budgetId) {
    setResponseStatus(event, 409);
    return errorEnvelope('SPACE_BUDGET_REQUIRED', 'The selected space has no bound budget.', null, false, requestId);
  }

  const parsedId = ProposalId.safeParse(event.context.params?.id);
  if (!parsedId.success) {
    setResponseStatus(event, 400);
    return errorEnvelope('INVALID_PROPOSAL_ID', 'Proposal ID is required.', null, false, requestId);
  }

  const workflow = getWorkflowStore(event as unknown as EventWithContext);
  if ('error' in workflow) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', 'Proposal execution is unavailable.', null, false, requestId);
  }

  const proposal = await workflow.store.getProposal(parsedId.data);
  if (
    !proposal ||
    proposal.spaceId !== selected.space.id ||
    proposal.budgetId !== selected.space.budgetId ||
    (proposal.operation !== 'set_category' && proposal.operation !== 'create_rule' &&
      proposal.operation !== 'update_rule' && proposal.operation !== 'delete_rule')
  ) {
    setResponseStatus(event, 404);
    return errorEnvelope('NOT_FOUND', 'Proposal is unavailable in the selected space.', null, false, requestId);
  }

  const admission = await workflow.store.getProposalApprovalSummary({
    proposalId: proposal.id, spaceId: selected.space.id,
    actorId: selected.auth.actorId, auth: selected.auth, now: new Date().toISOString(),
    requestId,
  }).catch(() => null);
  if (!admission?.executionAuthorized) {
    setResponseStatus(event, 404);
    return errorEnvelope('NOT_FOUND', 'Proposal is unavailable in the selected space.', null, false, requestId);
  }
  const capability = proposal.operation === 'set_category' ? 'categorization:execute' : 'rule:execute';
  const authorization = { info: { actorId: selected.auth.actorId, capability, allowed: true } };
  const actorId = selected.auth.actorId;
  const idempotencyKey = `${proposal.id}:execute:${actorId}`;
  const executionInput = {
    requestId, actorId, proposalId: proposal.id, auth: selected.auth,
    idempotencyKey, correlationId: requestId,
  };
  let result: ServiceResult | null;
  let terminalReplay: boolean;
  let publicationAuthority: (() => boolean) | undefined;
  let publicationRequired = false;
  const assertPublicationCurrent = () => {
    if (publicationRequired && !publicationAuthority)
      throw new Error('Current rule publication authority is unavailable');
    if (publicationAuthority && publicationAuthority() !== true)
      throw new Error('Current rule publication authority changed');
  };
  const withholdPublication = () => {
    setResponseStatus(event, 403);
    return errorEnvelope(
      'PUBLICATION_WITHHELD',
      'Authorized Actual rule creation was dispatched; private result withheld, not rolled back',
      authorization.info, false, requestId,
    );
  };
  const resolveReplayPublicationAuthority: ResolveRuleReplayPublicationAuthority = async (current) => {
    const sourceActor = selectedLiquidityActor(workflow.store, selected);
    if (!sourceActor || current.actorId !== selected.auth.actorId ||
        current.auth !== selected.auth || current.spaceId !== selected.space.id ||
        current.budgetId !== selected.space.budgetId)
      throw new Error('Current merchant replay actor or scope changed');
    const manager = createMutationConnectionManager({ configPath: process.env.BALANCEFRAME_CONFIG_PATH });
    const sourceService = await createMerchantIntelligenceService({ store: workflow.store, connectionManager: manager, research: composeScenarioResearch(event, selected.space.id) });
    const authorize = await sourceService.getRuleReplayPublicationAuthority({
      ...sourceActor, spaceId: selected.space.id, auth: selected.auth,
    }, current.context);
    publicationRequired = true;
    publicationAuthority = authorize;
    return authorize;
  };
  try {
    const record = await workflow.store.getIdempotencyRecord(idempotencyKey);
    terminalReplay = record?.status === 'succeeded' || record?.status === 'terminal_failed';
  } catch {
    setResponseStatus(event, 503);
    return errorEnvelope('EXECUTION_RECORD_UNAVAILABLE', 'Execution record is unavailable.', authorization.info, true, requestId);
  }
  if (terminalReplay) {
    result = proposal.operation === 'set_category'
      ? await new CategorizationMutationService(workflow.store, null, null).execute(executionInput)
      : await new RuleMutationService(workflow.store, null, null, async () => {
          throw new Error('Current rule source resolution is unavailable during no-ledger replay');
        }, resolveReplayPublicationAuthority).execute(executionInput);
  } else {
  publicationRequired = proposal.operation === 'create_rule';
  const sourceActor = selectedLiquidityActor(workflow.store,selected);
  if (proposal.operation === 'create_rule' && (!sourceActor ||
      !await hasNativeRuleSourceAdmission(workflow.store,sourceActor,'rule:execute'))) {
    setResponseStatus(event,403);
    return errorEnvelope('FORBIDDEN','Complete global rule and source authority is unavailable.',authorization.info,false,requestId);
  }


  const manager = createMutationConnectionManager({
    configPath: process.env.BALANCEFRAME_CONFIG_PATH,
  });
  let configured: ConnectionConfig | null;
  try {
    configured = await manager.loadConfig();
  } catch (error) {
    const safe = sanitizeError(error, requestId, 'LEDGER_UNAVAILABLE', true);
    setResponseStatus(event, 503);
    return errorEnvelope(safe.code, safe.message, authorization.info, safe.retryable, requestId);
  }
  if (!configured || configured.budgetId !== selected.space.budgetId) {
    setResponseStatus(event, 409);
    return errorEnvelope('BUDGET_MISMATCH', 'The configured budget does not match the selected space.', authorization.info, false, requestId);
  }

  let categorizationProtocol: RustMutationProtocol | null = null;
  let ruleProtocol: RustRuleMutationProtocol | null = null;
  try {
    if (proposal.operation === 'set_category')
      categorizationProtocol = await createNativeCategorizationMutationProtocol();
    else
      ruleProtocol = await createNativeRuleMutationProtocol();
  } catch {
    setResponseStatus(event, 501);
    return errorEnvelope('NATIVE_UNAVAILABLE', 'Native mutation verification is unavailable.', authorization.info, false, requestId);
  }

  try {
    result = await manager.withConnection(async (connected) => {
      if (
        connected.config.budgetId !== selected.space.budgetId ||
        connected.budget.id !== selected.space.budgetId
      )
        throw new Error('Connected budget does not match selected space');

      const ledger = connected.connector as unknown as BudgetLedger;
      if (proposal.operation === 'set_category') {
        if (!categorizationProtocol) throw new Error('Native categorization protocol is unavailable');
        const service = new CategorizationMutationService(workflow.store, ledger, categorizationProtocol);
        return service.execute({
          requestId,
          actorId,
          proposalId: proposal.id,
          auth: selected.auth,
          idempotencyKey,
          correlationId: requestId,
        });
      }
      if (!ruleProtocol) throw new Error('Native rule protocol is unavailable');
      const service = new RuleMutationService(workflow.store,ledger,ruleProtocol,async (current) => {
        if (!sourceActor || current.actorId !== selected.auth.actorId ||
            current.auth !== selected.auth || current.spaceId !== selected.space.id ||
            current.budgetId !== selected.space.budgetId)
          throw new Error('Current rule source actor or selected scope changed');
        const sourceService = await createMerchantIntelligenceService({store:workflow.store,connectionManager:manager,research:composeScenarioResearch(event,selected.space.id)});
        return sourceService.getCurrentRuleReviewContext({
          ...sourceActor,spaceId:selected.space.id,auth:selected.auth,
        },{evidenceKey:current.evidenceKey,connected,snapshot:current.snapshot,sourceAvailability:current.sourceAvailability,
          capturePublicationAuthority: (authorize) => {
            publicationAuthority = authorize;
            current.capturePublicationAuthority?.(authorize);
          }});
      }, resolveReplayPublicationAuthority);
      return service.execute({
        requestId,
        actorId,
        proposalId: proposal.id,
        auth: selected.auth,
        idempotencyKey,
        correlationId: requestId,
      });
    }, { expectedBudgetId: selected.space.budgetId, dispose: true, synchronize:false });
  } catch (error) {
    const safe = sanitizeError(error, requestId, 'LEDGER_UNAVAILABLE', true);
    setResponseStatus(event, safe.code === 'not_connected' ? 503 : 500);
    return errorEnvelope(safe.code, safe.message, authorization.info, safe.retryable, requestId);
  }
  }

  if (!result.success || !result.verified) {
    if (result.reasonCodes.includes('publication_withheld')) return withholdPublication();
    const { status, code, retryable } = executionError(result.reasonCodes);
    setResponseStatus(event, status);
    return errorEnvelope(code, 'Proposal execution did not complete.', authorization.info, retryable, requestId);
  }

  if (proposal.operation === 'create_rule' && result.reasonCodes.includes('idempotency_replay')) {
    try {
      const preconditions = z.record(z.string(), z.unknown()).parse(JSON.parse(proposal.preconditions) as unknown);
      const context = ruleReviewContextSchema.parse(preconditions.reviewContext);
      if (context.scope.spaceId !== proposal.spaceId || context.scope.budgetId !== proposal.budgetId)
        throw new Error('Ordinary rule replay scope differs from its governed proposal');
      // Exact acquisition proved this durable ordinary replay; no fresh source capture occurred.
      if (context.evidenceKey === null) publicationRequired = false;
    } catch {
      return withholdPublication();
    }
  }

  try {
    assertPublicationCurrent();
  } catch {
    return withholdPublication();
  }

  try {
    await workflow.store.supersedeProposal(proposal.id);
  } catch {
    // The verified financial result remains authoritative if cleanup fails.
  }

  try {
    assertPublicationCurrent();
  } catch {
    return withholdPublication();
  }

  const response = 'transactionId' in result
    ? {
        proposalId: proposal.id,
        transactionId: result.transactionId,
        categoryId: result.newCategoryId,
        verified: true as const,
      }
    : {
        proposalId: proposal.id,
        ruleId: result.ruleId,
        verified: true as const,
      };
  return okEnvelope(response, authorization.info, requestId);
});
