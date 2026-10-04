import { defineEventHandler, readBody, setHeader, setResponseStatus } from 'h3';
import type { H3Event } from 'h3';
import { createNativeCategorizationMutationProtocol } from '@balanceframe/application';
import type { RustMutationProtocol } from '@balanceframe/application';
import type { BudgetLedger } from '@balanceframe/actual-adapter';
import {
  GENERIC_MUTATION_POLICY_VERSION,
  ProposalAcquisitionError,
  canonicalProposalJson,
} from '@balanceframe/workflow-store';
import { z } from 'zod';
import { createMutationConnectionManager } from '../../utils/mutation-executor';
import { buildCategorizationProposalIntent } from '../../utils/categorization-proposal';
import { requireSelectedSpace } from '../../utils/space-context';
import type { EventWithContext } from '../../utils/workflow-store';
import {
  classifyConnectionError,
  errorEnvelope,
  getWorkflowStore,
  okEnvelope,
  requireProposalAuthorization,
  sanitizeError,
} from '../../utils/workflow-store';

const CreateProposalBody = z.object({
  transactionId: z.string().trim().min(1).max(200),
  categoryId: z.string().trim().min(1).max(200),
  operation: z.literal('set_category').optional(),
  message: z.string().trim().min(1).max(500).optional(),
  reason: z.string().trim().min(1).max(1000).optional(),
}).strict();

function fail(
  event: H3Event,
  requestId: string,
  status: number,
  code: string,
  message: string,
  authorization: Parameters<typeof errorEnvelope>[2] = null,
  retryable = false,
) {
  setResponseStatus(event, status);
  return errorEnvelope(code, message, authorization, retryable, requestId);
}

export default defineEventHandler(async (event) => {
  const requestId = crypto.randomUUID();
  setHeader(event, 'Cache-Control', 'private, no-store');
  const context = event as unknown as EventWithContext;
  const selected = await requireSelectedSpace(context);
  if (!selected.ok) return selected.response;
  const budgetId = selected.space.budgetId;
  if (!budgetId)
    return fail(event, requestId, 409, 'SPACE_BUDGET_REQUIRED', 'The selected space has no bound budget.');

  let body: unknown;
  try {
    body = await readBody<unknown>(event);
  } catch {
    return fail(event, requestId, 400, 'INVALID_BODY', 'The proposal request body is invalid.');
  }
  const parsed = CreateProposalBody.safeParse(body);
  if (!parsed.success)
    return fail(event, requestId, 400, 'INVALID_BODY', 'Expected a set-category transaction and category.');
  const operation = parsed.data.operation ?? 'set_category';
  const authorization = await requireProposalAuthorization(
    context,
    'categorization:propose',
    `budget:${budgetId}`,
    operation,
  );
  if (!authorization.ok) return authorization.response;
  for (const scope of [
    `transaction:${parsed.data.transactionId}`,
    `category:${parsed.data.categoryId}`,
  ]) {
    const resourceAuthorization = await requireProposalAuthorization(
      context, 'categorization:propose', scope, operation,
    );
    if (!resourceAuthorization.ok) return resourceAuthorization.response;
  }

  const workflow = getWorkflowStore(context);
  if ('error' in workflow)
    return fail(event, requestId, 503, 'STORE_UNAVAILABLE', 'Proposal creation is unavailable.', authorization.info);

  const manager = createMutationConnectionManager({ configPath: process.env.BALANCEFRAME_CONFIG_PATH });
  try {
    const configured = await manager.loadConfig();
    if (!configured || configured.budgetId !== budgetId)
      return fail(event, requestId, 409, 'BUDGET_MISMATCH', 'The configured budget does not match the selected space.', authorization.info);
  } catch (error) {
    const safe = classifyConnectionError(error) ?? sanitizeError(error, requestId, 'LEDGER_UNAVAILABLE', true);
    return fail(event, requestId, 503, safe.code, 'The selected budget connection is unavailable.', authorization.info, safe.retryable);
  }

  let protocol: RustMutationProtocol;
  try {
    protocol = await createNativeCategorizationMutationProtocol();
  } catch {
    return fail(event, requestId, 501, 'NATIVE_UNAVAILABLE', 'Native mutation planning is unavailable.', authorization.info);
  }

  try {
    return await manager.withConnection(async (connected) => {
      if (connected.config.budgetId !== budgetId || connected.budget.id !== budgetId)
        return fail(event, requestId, 409, 'BUDGET_MISMATCH', 'The connected budget does not match the selected space.', authorization.info);

      const synchronized = await (connected.connector as unknown as BudgetLedger).synchronize();
      const transaction = synchronized.snapshot.transactions.find(({ id }) => id === parsed.data.transactionId);
      const category = synchronized.snapshot.categories.find(({ id }) => id === parsed.data.categoryId);
      if (!transaction || !category)
        return fail(event, requestId, 403, 'FORBIDDEN', 'Complete categorization proposal authority is unavailable.', authorization.info);

      const presentation = parsed.data.message || parsed.data.reason
        ? {
            ...(parsed.data.message ? { message: parsed.data.message } : {}),
            ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
          }
        : undefined;
      const intent = buildCategorizationProposalIntent({
        protocol,
        snapshot: synchronized.snapshot,
        transaction,
        category,
        ...(presentation ? { presentation } : {}),
      });
      const proposal = await workflow.store.createProposal({
        operation,
        budgetId,
        spaceId: selected.space.id,
        payload: intent.payload,
        policyVersion: GENERIC_MUTATION_POLICY_VERSION,
        preconditions: canonicalProposalJson(intent.preconditions),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        actorId: selected.auth.actorId,
        auth: selected.auth,
        provenance: 'proposal-route',
        correlationId: requestId,
      });
      if (!proposal.governancePolicyVersion)
        return fail(event, requestId, 409, 'PROPOSAL_UNAVAILABLE', 'The exact proposal could not be created.', authorization.info);

      return okEnvelope({
        proposal: {
          id: proposal.id,
          operation: proposal.operation,
          payloadHash: proposal.payloadHash,
          expiresAt: proposal.expiresAt,
        },
        state: 'approval_required' as const,
        applied: false as const,
        verified: false as const,
      }, authorization.info, requestId);
    }, { expectedBudgetId: budgetId, dispose: true });
  } catch (error) {
    if (event.node.res.headersSent) throw error;
    const connectionError = classifyConnectionError(error);
    if (connectionError)
      return fail(event, requestId, 503, connectionError.code, connectionError.message, authorization.info, connectionError.retryable);
    if (error instanceof ProposalAcquisitionError && error.reasonCode === 'authorization_denied')
      return fail(event, requestId, 403, 'FORBIDDEN', 'Complete categorization proposal authority is unavailable.', authorization.info);
    const safe = sanitizeError(error, requestId, 'PROPOSAL_CREATE_FAILED', true);
    return fail(event, requestId, safe.code === 'not_connected' ? 503 : 409, safe.code, 'A current categorization proposal could not be created.', authorization.info, safe.retryable);
  }
});
