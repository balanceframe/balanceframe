/**
 * POST /api/findings/:id/correct — mark a finding as corrected.
 *
 * No-mutation contract: only changes finding state, never mutates ledger.
 * Reads finding ID from URL param, expectedVersion and correctionRef from
 * JSON body.
 *
 * Request body: { expectedVersion: number, correctionRef: string }
 * Response envelope: Finding
 */

import { defineEventHandler, readBody, getRouterParam, setResponseStatus } from 'h3';
import {
  getWorkflowStore,
  okEnvelope,
  errorEnvelope,
  buildAuthorizationInfo,
  getActorId,
  requireAuthorization,
  sanitizeError,
} from '../../../utils/workflow-store';

export default defineEventHandler(async (event) => {
  const authCheck = await requireAuthorization(event, 'finding:transition');
  if (!authCheck.ok) return authCheck.response;
  const authInfo = authCheck.info;
  const requestId = crypto.randomUUID();
  const findingId = getRouterParam(event, 'id') ?? '';

  if (!findingId) {
    setResponseStatus(event, 400);
    return errorEnvelope(
      'MISSING_FINDING_ID',
      'Finding ID is required.',
      authInfo,
      false,
      requestId,
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await readBody(event)) ?? {};
  } catch {
    setResponseStatus(event, 400);
    return errorEnvelope(
      'INVALID_BODY',
      'Request body must be valid JSON.',
      authInfo,
      false,
      requestId,
    );
  }

  const expectedVersion = typeof body.expectedVersion === 'number' ? body.expectedVersion : -1;
  if (expectedVersion < 0) {
    setResponseStatus(event, 400);
    return errorEnvelope(
      'MISSING_VERSION',
      'expectedVersion is required and must be a non-negative number.',
      authInfo,
      false,
      requestId,
    );
  }

  const correctionRef = typeof body.correctionRef === 'string' ? body.correctionRef.trim() : '';
  if (!correctionRef) {
    setResponseStatus(event, 400);
    return errorEnvelope(
      'MISSING_CORRECTION_REF',
      'correctionRef is required and must reference a correction record.',
      authInfo,
      false,
      requestId,
    );
  }

  const wf = getWorkflowStore(event);
  if ('error' in wf) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', wf.error, authInfo, false, requestId);
  }

  try {
    const finding = await wf.store.correctFinding({
      findingId,
      actorId: getActorId(event),
      correctionRef,
      expectedVersion,
    });
    return okEnvelope(finding, authInfo, requestId);
  } catch (error) {
    const safe = sanitizeError(error, requestId, 'CORRECT_FAILED', false);
    setResponseStatus(event, safe.code === 'not_connected' ? 503 : 500);
    return errorEnvelope(safe.code, safe.message, authInfo, safe.retryable, requestId);
  }
});
