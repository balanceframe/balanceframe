/**
 * GET /api/home/attention — get the prioritized attention/home dashboard.
 *
 * Read-only deterministic analysis — no model or cloud invocation.
 * Requires observe authorization before accessing configuration or ledger state.
 *
 * Query params: categoryGroup (optional), detailed (optional boolean), month (optional YYYY-MM)
 * Response envelope: AttentionHomeOutput
 */

import {
  createDefaultConnectionManager,
  createNativeAnalysisProtocol,
  attentionHomeAnalysis,
  LiquidityProjector,
} from '@balanceframe/application';
import type { CommandInput, AttentionHomeParams } from '@balanceframe/application';
import { hasLegacyFullRead } from '../../utils/legacy-financial-read';
import { defineEventHandler, getQuery, setHeader, setResponseStatus } from 'h3';
import {
  getWorkflowStore,
  okEnvelope,
  errorEnvelope,
  requireAuthorization,
  sanitizeError,
  envelopeMetadata,
} from '../../utils/workflow-store';
import type { EventWithContext } from '../../utils/workflow-store';
import { requireSelectedSpace } from '../../utils/space-context';
import { selectedLiquidityActor } from '../../utils/liquidity-service';
import { z } from 'zod';

/** Map an analysis error code to an HTTP status. */
function httpStatusForCode(code: string): number {
  if (code.includes('not_connected') || code.includes('no_analysis') || code.startsWith('stale_')) {
    return 503;
  }
  if (
    code.toUpperCase().endsWith('_REQUIRED') ||
    code.startsWith('invalid') ||
    code.startsWith('missing') ||
    code.includes('MISSING')
  ) {
    return 400;
  }
  return 500;
}

/** Return whether an unknown failure carries the requested application error code. */
function errorHasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Keep canonical reference identity/status while withholding any attached
 * details when the reference is not authorized for this response.
 */
function sanitizeEvidenceReference(reference: unknown): unknown {
  if (!isJsonObject(reference)) return reference;

  const isCanonicalReference = 'authorized' in reference || 'redaction' in reference;
  const isRestricted =
    isCanonicalReference && (reference.authorized !== true || reference.redaction === 'redacted');
  if (!isRestricted) return sanitizeCanonicalEvidence(reference);

  const sanitized: JsonObject = {};
  for (const field of ['evidenceId', 'kind', 'authorized', 'redaction']) {
    if (field in reference) sanitized[field] = reference[field];
  }
  return sanitized;
}

/**
 * Clone the analysis result at the server boundary, removing raw evidence
 * containers and reducing restricted canonical references to safe metadata.
 */
function sanitizeCanonicalEvidence(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeCanonicalEvidence(entry));
  }
  if (!isJsonObject(value)) return value;

  const sanitized: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'rawEvidence' || key === 'rawPayload') continue;
    sanitized[key] =
      key === 'evidence' && Array.isArray(entry)
        ? entry.map((reference) => sanitizeEvidenceReference(reference))
        : sanitizeCanonicalEvidence(entry);
  }
  return sanitized;
}

const HomeQuery = z.object({
  categoryGroup: z.string().trim().min(1).max(120).optional(),
  detailed: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
}).strict();
export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'private, no-store');
  const requestId = crypto.randomUUID();
  const selected = await requireSelectedSpace(event as unknown as EventWithContext);
  if (!selected.ok) return selected.response;
  const budgetId = selected.space.budgetId;
  if (!budgetId) {
    setResponseStatus(event, 409);
    return errorEnvelope('SPACE_BUDGET_REQUIRED', 'The selected space has no bound budget.', null, false, requestId);
  }
  const authorization = await requireAuthorization(
    event as unknown as EventWithContext,
    'observe',
    `budget:${budgetId}`,
  );
  if (!authorization.ok) return authorization.response;
  const authInfo = authorization.info;
  const query = HomeQuery.safeParse(getQuery(event));
  if (!query.success) {
    setResponseStatus(event, 400);
    return errorEnvelope('INVALID_HOME_QUERY', 'Use supported attention filters.', authInfo, false, requestId);
  }

  const workflow = getWorkflowStore(event as unknown as EventWithContext);
  if ('error' in workflow) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', workflow.error, authInfo, true, requestId);
  }
  const actor = selectedLiquidityActor(workflow.store, selected);
  if (!actor) {
    setResponseStatus(event, 403);
    return errorEnvelope('FORBIDDEN', 'The selected space is unavailable.', authInfo, false, requestId);
  }
  const manager = createDefaultConnectionManager({
    configPath: process.env.BALANCEFRAME_CONFIG_PATH,
  });

  try {
    const config = await manager.loadConfig();
    if (!config || config.budgetId !== budgetId) {
      setResponseStatus(event, 409);
      return errorEnvelope(
        'SPACE_CONNECTION_MISMATCH',
        'The configured budget does not match the selected space.',
        authInfo,
        false,
        requestId,
      );
    }

    const context: AttentionHomeParams['context'] = {};
    if (query.data.categoryGroup !== undefined) context.categoryGroup = query.data.categoryGroup;
    if (query.data.detailed !== undefined) context.detailed = query.data.detailed;
    if (query.data.month !== undefined) context.month = query.data.month;
    const params: AttentionHomeParams = {
      ...(Object.keys(context).length > 0 ? { context } : {}),
    };

    const transferConclusionScope = {
      ...actor,
      resourceKind: 'budget' as const,
      resourceId: budgetId,
      capability: 'conclusion' as const,
      operation: 'transfer',
      phase: 'read' as const,
    };
    const activeTransfers = (
      workflow.store.liquidity.isAuthorized({ ...transferConclusionScope, visibility: 'resource' }) ||
      workflow.store.liquidity.isAuthorized({ ...transferConclusionScope, visibility: 'aggregate' })
    )
      ? workflow.store.liquidity
          .listTransferProposalIntents({ ...actor, capability: 'conclusion' })
          .filter((proposal) =>
            proposal.state.outcome && !['confirmed', 'closed'].includes(proposal.state.phase),
          )
      : [];
    const transferBlockers = activeTransfers.flatMap((proposal) => {
      const transferConclusion = LiquidityProjector.transferConclusion(
        workflow.store,
        actor,
        proposal.payload.plan,
      );
      return transferConclusion
        ? [{
            code: 'transfer_needs_attention',
            classification: 'transfer_needs_attention',
            severity: 'warning',
            message: 'A transfer needs authorized review. Acknowledgement is not settlement.',
            transferConclusion,
          }]
        : [];
    });

    if (!(await hasLegacyFullRead(workflow.store, actor))) {
      return okEnvelope(
        {
          blockers: transferBlockers,
          alerts: [],
          recurrences: [],
          categoryRisks: [],
          scopeLimited: true,
        },
        authInfo,
        requestId,
      );
    }

    const envelope = await manager.withConnection(async (connected) => {
      if (connected.config.budgetId !== budgetId || connected.budget.id !== budgetId)
        throw new Error('Selected budget changed');
      const protocol = await createNativeAnalysisProtocol();
      const input: CommandInput = {
        args: [],
        mode: 'observe',
        actorId: selected.auth.actorId,
        requestId,
        ledger: connected.connector,
        freshness: null,
        analysisProtocol: protocol,
      };
      return attentionHomeAnalysis(input, params);
    }, { expectedBudgetId: budgetId, dispose: true });

    if (envelope.status === 'ok') {
      const sanitized = z.object({ blockers: z.array(z.unknown()) }).passthrough().parse(
        sanitizeCanonicalEvidence(envelope.result),
      );
      return okEnvelope(
        { ...sanitized, blockers: [...sanitized.blockers, ...transferBlockers] },
        authInfo,
        envelope.requestId,
        envelopeMetadata(envelope),
      );
    }

    const status = httpStatusForCode(envelope.error.code);
    setResponseStatus(event, status);
    return errorEnvelope(
      envelope.error.code,
      envelope.error.message,
      authInfo,
      envelope.error.retryable,
      envelope.requestId,
      envelopeMetadata(envelope),
    );
  } catch (error) {
    if (errorHasCode(error, 'not_connected')) {
      setResponseStatus(event, 503);
      return errorEnvelope(
        'not_connected',
        'No ledger connected. Configure an Actual budget first.',
        authInfo,
        true,
        requestId,
      );
    }
    const safe = sanitizeError(error, requestId, 'ANALYSIS_FAILED', true);
    setResponseStatus(event, 500);
    return errorEnvelope(safe.code, safe.message, authInfo, safe.retryable, requestId);
  }
});
