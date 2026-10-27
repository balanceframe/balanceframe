import { defineEventHandler, setHeader, setResponseStatus } from 'h3';
import { z } from 'zod';
import {
  CategorizationPreviewError,
  CategorizationPreviewService,
  createDefaultConnectionManager,
  createNativeCategorizationMutationProtocol,
} from '@balanceframe/application';
import { hasTrustedRequestOrigin } from '../../../utils/reauthentication';
import type { ReauthenticationEvent } from '../../../utils/reauthentication';
import { requireSelectedSpace } from '../../../utils/space-context';
import { errorEnvelope, getWorkflowStore, okEnvelope } from '../../../utils/workflow-store';
import type { EventWithContext } from '../../../utils/workflow-store';

const ProposalId = z.string().trim().min(1).max(200);

/** Synchronization-capable preparation followed by a non-admitting categorization preview. */
export default defineEventHandler(async (event) => {
  const requestId = crypto.randomUUID();
  setHeader(event, 'Cache-Control', 'private, no-store');
  if (!hasTrustedRequestOrigin(event as unknown as ReauthenticationEvent)) {
    setResponseStatus(event, 403);
    return errorEnvelope(
      'FORBIDDEN',
      'Categorization preview is unavailable.',
      null,
      false,
      requestId,
    );
  }
  const request = event as unknown as EventWithContext;
  const selected = await requireSelectedSpace(request);
  if (!selected.ok) return selected.response;
  if (selected.auth.method === 'api-key' && selected.auth.principalType === 'agent') {
    setResponseStatus(event, 403);
    return errorEnvelope(
      'FORBIDDEN',
      'Categorization preview requires current human read authority.',
      null,
      false,
      requestId,
    );
  }
  if (!selected.space.budgetId) {
    setResponseStatus(event, 409);
    return errorEnvelope(
      'SPACE_BUDGET_REQUIRED',
      'The selected space has no bound budget.',
      null,
      false,
      requestId,
    );
  }
  const id = ProposalId.safeParse(event.context.params?.id);
  if (!id.success) {
    setResponseStatus(event, 400);
    return errorEnvelope('INVALID_PROPOSAL_ID', 'Proposal ID is required.', null, false, requestId);
  }
  const workflow = getWorkflowStore(request);
  if ('error' in workflow) {
    setResponseStatus(event, 503);
    return errorEnvelope(
      'STORE_UNAVAILABLE',
      'Categorization preview is unavailable.',
      null,
      true,
      requestId,
    );
  }
  try {
    const service = new CategorizationPreviewService({
      store: workflow.store,
      connectionManager: createDefaultConnectionManager({
        configPath: process.env.BALANCEFRAME_CONFIG_PATH,
      }),
      protocol: await createNativeCategorizationMutationProtocol(),
    });
    const report = await service.preview({
      proposalId: id.data,
      actorId: selected.auth.actorId,
      auth: selected.auth,
      spaceId: selected.space.id,
      budgetId: selected.space.budgetId,
      requestId,
    });
    const current = await requireSelectedSpace(request);
    if (!current.ok) return current.response;
    if (
      current.space.id !== selected.space.id ||
      current.space.budgetId !== selected.space.budgetId ||
      current.auth.actorId !== selected.auth.actorId
    ) {
      setResponseStatus(event, 409);
      return errorEnvelope(
        'PREVIEW_WITHHELD',
        'The selected space changed; private preview withheld.',
        null,
        false,
        requestId,
      );
    }
    return okEnvelope(report, null, requestId);
  } catch (error) {
    const known = error instanceof CategorizationPreviewError;
    setResponseStatus(event, known ? error.statusCode : 503);
    return errorEnvelope(
      known ? error.code : 'PREVIEW_UNAVAILABLE',
      'Preview unavailable. Actual may have synchronized; the preview does not submit the proposed categorization.',
      null,
      !known || error.statusCode >= 500,
      requestId,
    );
  }
});
