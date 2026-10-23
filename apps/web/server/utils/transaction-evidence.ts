import { defineEventHandler, getQuery, setHeader, setResponseStatus, type H3Event } from 'h3';
import { z } from 'zod';
import type { MerchantActor, TransactionEvidenceService } from '@balanceframe/application';
import { createWebTransactionEvidenceService } from './evidence-service';
import { selectedLiquidityActor } from './liquidity-service';
import { BoundedJsonBodyError } from './bounded-json';
import {
  getHumanControlAuth,
  hasTrustedRequestOrigin,
  type ReauthenticationEvent,
} from './reauthentication';
import { requireSelectedSpace } from './space-context';
import {
  errorEnvelope,
  getWorkflowStore,
  okEnvelope,
  requireAuthorization,
  type AuthorizationInfo,
  type EventWithContext,
} from './workflow-store';

/** Admit the selected authenticated actor before evidence operations. */
export function evidenceRoute<T>(
  operation: (
    event: H3Event,
    service: TransactionEvidenceService,
    actor: MerchantActor,
  ) => Promise<T>,
  options: { write?: boolean; human?: boolean; capability?: string } = {},
) {
  return defineEventHandler(async (event) => {
    setHeader(event, 'Cache-Control', 'private, no-store');
    const requestId = crypto.randomUUID();
    let authorization: AuthorizationInfo | null = null;
    try {
      if (
        (options.write || options.human) &&
        !hasTrustedRequestOrigin(event as ReauthenticationEvent)
      ) {
        setResponseStatus(event, 403);
        return errorEnvelope(
          'FORBIDDEN',
          'Evidence operation is unavailable.',
          null,
          false,
          requestId,
        );
      }
      const selected = requireSelectedSpace(event as unknown as EventWithContext);
      if (!selected.ok) return selected.response;
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
      const admitted = await requireAuthorization(
        event as unknown as EventWithContext,
        options.capability ?? 'observe',
        `budget:${selected.space.budgetId}`,
      );
      if (!admitted.ok) return admitted.response;
      authorization = admitted.info;
      z.object({}).strict().parse(getQuery(event));
      const workflow = getWorkflowStore(event as unknown as EventWithContext);
      if ('error' in workflow) {
        setResponseStatus(event, 503);
        return errorEnvelope(
          'STORE_UNAVAILABLE',
          'Evidence storage is unavailable.',
          authorization,
          true,
          requestId,
        );
      }
      const base = selectedLiquidityActor(workflow.store, selected);
      if (!base?.auth || !base.spaceId) {
        setResponseStatus(event, 403);
        return errorEnvelope(
          'FORBIDDEN',
          'Evidence is unavailable.',
          authorization,
          false,
          requestId,
        );
      }
      let actor: MerchantActor = { ...base, spaceId: base.spaceId, auth: base.auth };
      if (options.human) {
        const proof = await getHumanControlAuth(event as ReauthenticationEvent);
        if (
          !proof ||
          proof.actorId !== actor.actorId ||
          selected.auth.method !== 'session' ||
          proof.sessionId !== selected.auth.sessionId
        ) {
          setResponseStatus(event, 403);
          return errorEnvelope(
            'REAUTHENTICATION_REQUIRED',
            'Confirm your current human session before evidence control.',
            authorization,
            false,
            requestId,
          );
        }
        actor = { ...actor, auth: { ...selected.auth, ...proof } };
      }
      const service = await createWebTransactionEvidenceService(workflow.store, event);
      const result = await operation(event, service, actor);
      return okEnvelope(result, authorization, requestId);
    } catch (error) {
      const invalid =
        error instanceof BoundedJsonBodyError ||
        error instanceof z.ZodError ||
        (error instanceof Error && error.name === 'ZodError');
      const oversized = error instanceof BoundedJsonBodyError && error.statusCode === 413;
      setResponseStatus(event, oversized ? 413 : invalid ? 400 : authorization ? 409 : 503);
      return errorEnvelope(
        oversized
          ? 'EVIDENCE_REQUEST_TOO_LARGE'
          : invalid
            ? 'INVALID_EVIDENCE_REQUEST'
            : 'EVIDENCE_UNAVAILABLE',
        oversized
          ? 'Use an evidence request within the supported size limit.'
          : invalid
            ? 'Provide a valid evidence request.'
            : 'Evidence, source state, or current permission changed. Refresh before retrying.',
        authorization,
        false,
        requestId,
      );
    }
  });
}
