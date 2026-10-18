import { defineEventHandler, readBody, setHeader, setResponseStatus } from 'h3';
import { consequentialActionIntentSchema } from '@balanceframe/protocol-generated/validators';
import { ApplicationError, spendSessionInputSchema } from '@balanceframe/application';
import { z } from 'zod';
import { createWebConsequentialActionService, selectedLiquidityActor } from '../../utils/liquidity-service';
import { requireSelectedSpace } from '../../utils/space-context';
import type { EventWithContext } from '../../utils/workflow-store';
import { errorEnvelope, getWorkflowStore, okEnvelope, sanitizeError } from '../../utils/workflow-store';
import { hasTrustedRequestOrigin } from '../../utils/reauthentication';
import type { ReauthenticationEvent } from '../../utils/reauthentication';
import { projectConsequentialActionProposal } from '../../utils/proposal-route';


const SessionSelector = z.object({
  sessionId: z.string().trim().min(1).max(256),
  sessionVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict();
const ActionRequest = z.object({
  action: z.unknown(),
  decision: z.unknown().optional(),
}).strict();
const SavedSessionDecision = z.object({ origin: SessionSelector }).strict();
const CartDecision = spendSessionInputSchema.extend({
  expiresAt: spendSessionInputSchema.shape.expiresAt.optional(),
});

export default defineEventHandler(async (event) => {
  const requestId = crypto.randomUUID();
  setHeader(event, 'Cache-Control', 'private, no-store');
  if (!hasTrustedRequestOrigin(event as ReauthenticationEvent)) {
    setResponseStatus(event, 403);
    return errorEnvelope('FORBIDDEN', 'Action proposal is unavailable.', null, false, requestId);
  }
  const context = event as unknown as EventWithContext;
  const selected = await requireSelectedSpace(context);
  if (!selected.ok) return selected.response;
  const budgetId = selected.space.budgetId;
  if (!budgetId) {
    setResponseStatus(event, 409);
    return errorEnvelope('SPACE_BUDGET_REQUIRED', 'The selected space has no bound budget.', null, false, requestId);
  }
  let body: unknown;
  try {
    body = await readBody<unknown>(event);
  } catch {
    setResponseStatus(event, 400);
    return errorEnvelope('INVALID_BODY', 'The action proposal request body is invalid.', null, false, requestId);
  }
  const parsed = ActionRequest.safeParse(body);
  if (!parsed.success ||
      !consequentialActionIntentSchema.safeParse(parsed.data.action).success ||
      (parsed.data.decision !== undefined &&
       !SavedSessionDecision.safeParse(parsed.data.decision).success &&
       !CartDecision.safeParse(parsed.data.decision).success)) {
    setResponseStatus(event, 400);
    return errorEnvelope('INVALID_BODY', 'Expected only an action and optional decision intent.', null, false, requestId);
  }
  const workflow = getWorkflowStore(context);
  if ('error' in workflow) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', 'Action proposals are unavailable.', null, true, requestId);
  }
  const actor = selectedLiquidityActor(workflow.store, selected);
  if (!actor) {
    setResponseStatus(event, 403);
    return errorEnvelope('FORBIDDEN', 'The selected space is unavailable.', null, false, requestId);
  }
  try {
    const service = await createWebConsequentialActionService(workflow.store);
    const proposal = await service.propose(actor, parsed.data);
    const approval = await workflow.store.getProposalApprovalSummary({
      proposalId: proposal.id,
      spaceId: selected.space.id,
      actorId: selected.auth.actorId,
      auth: selected.auth,
      now: new Date().toISOString(),
      requestId,
    });
    if (!approval.privateEnvelopeVisible)
      throw new ApplicationError({
        code: 'PROPOSAL_CREATED_DETAILS_WITHHELD',
        message: 'Proposal persisted; current financial detail publication is unavailable',
        retryable: false,
      });
    const currentAssistanceMaximum =
      workflow.store.governance.getPolicy({ spaceId: selected.space.id })?.assistanceMaximum ?? 'analysis_only';
    return okEnvelope({
      proposal: projectConsequentialActionProposal(
        proposal,
        { ...approval, disposition: approval.disposition.kind },
        currentAssistanceMaximum,
      ),
    }, null, requestId);
  } catch (error) {
    if (error instanceof ApplicationError && error.code === 'PROPOSAL_CREATED_DETAILS_WITHHELD') {
      setResponseStatus(event, 403);
      return errorEnvelope(
        error.code,
        'The proposal was persisted, but its financial details cannot be disclosed under current authority. Do not resubmit the intent.',
        null,
        false,
        requestId,
      );
    }
    const message = error instanceof Error ? error.message : '';
    if (error instanceof z.ZodError) {
      setResponseStatus(event, 400);
      return errorEnvelope('INVALID_BODY', 'The action or decision intent is invalid.', null, false, requestId);
    }
    if (/configured budget does not match/i.test(message)) {
      setResponseStatus(event, 409);
      return errorEnvelope('SPACE_CONNECTION_MISMATCH', 'The configured budget does not match the selected space.', null, false, requestId);
    }
    if (/authorization|capability|scope|assistance|membership|private source/i.test(message)) {
      setResponseStatus(event, 403);
      return errorEnvelope('FORBIDDEN', 'The action or its current resources are not authorized.', null, false, requestId);
    }
    if (/changed|stale|conflict|expired|insufficient|precondition|evidence|funding|target|reallocation_not_safe_in_decision_card/i.test(message)) {
      setResponseStatus(event, 409);
      return errorEnvelope('ACTION_STATE_CHANGED', 'The current action source or authorization changed. Refresh and review before proposing again.', null, false, requestId);
    }
    if (/native|binding/i.test(message)) {
      setResponseStatus(event, 501);
      return errorEnvelope('NATIVE_UNAVAILABLE', 'Native action planning is unavailable.', null, false, requestId);
    }
    const safe = sanitizeError(error, requestId, 'ACTION_UNAVAILABLE', true);
    setResponseStatus(event, 503);
    return errorEnvelope(safe.code, safe.message, null, safe.retryable, requestId);
  }
});
