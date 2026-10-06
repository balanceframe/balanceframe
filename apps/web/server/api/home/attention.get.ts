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
  ApplicationError,
  merchantConnectionId,
  createMerchantIntelligenceService,
} from '@balanceframe/application';
import type { CommandInput, AttentionHomeParams } from '@balanceframe/application';
import type { GovernanceOperation, LiquidityActor } from '@balanceframe/workflow-store';
import { canonicalProtocolSnapshotSchema, financialSnapshotSchema } from '@balanceframe/protocol-generated/validators';
import { hasLegacyFullRead, financialReadMoneyOperation, financialSourceReadOperations } from '../../utils/legacy-financial-read';
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
import { merchantAnalysisAuthorized } from '../../utils/merchant-service';
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

/** Count the complete returned Money collection; only known outflow roles carry outgoing direction. */
function attentionDisclosureOperations(value: unknown): GovernanceOperation[] {
  const operations: GovernanceOperation[] = [];
  type Role = 'home' | 'blocker' | 'recurrence' | 'risk' | 'transfer' | 'unknown';
  const moneyFields: Partial<Record<Role, Readonly<Record<string, 'balance' | 'directional' | 'outgoing'>>>> = {
    recurrence: { amount: 'directional' },
    risk: { remainingBudget: 'balance' },
    transfer: { minimumAmount: 'outgoing' },
  };
  const childFields: Partial<Record<Role, Readonly<Record<string, Role>>>> = {
    home: { blockers: 'blocker', recurrences: 'recurrence', categoryRisks: 'risk' },
    blocker: { transferConclusion: 'transfer' },
  };
  const visit = (entry: unknown, role: Role): void => {
    if (Array.isArray(entry)) {
      for (const child of entry) visit(child, role);
      return;
    }
    if (!isJsonObject(entry)) return;
    if ('minorUnits' in entry || 'currency' in entry) throw new Error('Unknown attention Money role');
    for (const [field, child] of Object.entries(entry)) {
      const fields = moneyFields[role];
      const children = childFields[role];
      const moneyRole = fields && Object.hasOwn(fields, field) ? fields[field] : undefined;
      if (moneyRole) operations.push(financialReadMoneyOperation(child, moneyRole));
      else visit(child, children && Object.hasOwn(children, field) ? children[field]! : 'unknown');
    }
  };
  visit(value, 'home');
  return operations;
}

const HomeQuery = z.object({
  categoryGroup: z.string().trim().min(1).max(120).optional(),
  detailed: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
}).strict();
export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'private, no-store');
  const requestId = crypto.randomUUID();
  const selected = requireSelectedSpace(event as unknown as EventWithContext);
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
  const forbidden = () => {
    setResponseStatus(event, 403);
    return errorEnvelope('FORBIDDEN', 'Financial attention is unavailable.', authInfo, false, requestId);
  };
  const currentActor = (): LiquidityActor | null => {
    const current = requireSelectedSpace(event as unknown as EventWithContext);
    if (!current.ok || current.space.id !== selected.space.id || current.space.budgetId !== budgetId ||
        current.membership.id !== selected.membership.id || current.auth.actorId !== selected.auth.actorId ||
        current.auth.method !== selected.auth.method) return null;
    if (current.auth.method === 'session' && (selected.auth.method !== 'session' ||
        current.auth.sessionId !== selected.auth.sessionId)) return null;
    if (current.auth.method === 'api-key') {
      if (selected.auth.method !== 'api-key' ||
          current.auth.credentialId !== selected.auth.credentialId ||
          current.auth.credentialOwnerId !== selected.auth.credentialOwnerId ||
          current.auth.principalType !== selected.auth.principalType) return null;
      if (current.auth.principalType === 'agent' && (selected.auth.principalType !== 'agent' ||
          current.auth.delegationId !== selected.auth.delegationId ||
          current.auth.delegationVersion !== selected.auth.delegationVersion)) return null;
    }
    const live = selectedLiquidityActor(workflow.store, current);
    return live && live.governancePolicyVersion === actor.governancePolicyVersion &&
      workflow.store.liquidity.isAuthorized({
        ...live, resourceKind: 'budget', resourceId: budgetId, capability: 'observe',
        operation: 'observe', phase: 'read', visibility: 'resource',
      }) ? live : null;
  };
  const transferBlockers = (live: LiquidityActor) => {
    const scope = {
      ...live, resourceKind: 'budget' as const, resourceId: budgetId,
      capability: 'conclusion' as const, operation: 'transfer', phase: 'read' as const,
    };
    if (!workflow.store.liquidity.isAuthorized({ ...scope, visibility: 'resource' }) &&
        !workflow.store.liquidity.isAuthorized({ ...scope, visibility: 'aggregate' })) return [];
    const blockers = workflow.store.liquidity.listTransferProposalIntents({ ...live, capability: 'conclusion' })
      .filter((proposal) => proposal.state.outcome && !['confirmed', 'closed'].includes(proposal.state.phase))
      .flatMap((proposal) => {
        const conclusion = LiquidityProjector.transferConclusion(workflow.store, live, proposal.payload.plan);
        return conclusion ? [{
          code: 'transfer_needs_attention',
          classification: 'transfer_needs_attention',
          severity: 'warning',
          message: 'A transfer needs authorized review. Acknowledgement is not settlement.',
          transferConclusion: conclusion,
        }] : [];
      });
    const operations = blockers.map((blocker) => ({
      ...financialReadMoneyOperation(blocker.transferConclusion.minimumAmount, 'outgoing'), operation: 'transfer',
    }));
    return workflow.store.liquidity.isAuthorized({ ...scope, visibility: 'resource', operations }) ||
      workflow.store.liquidity.isAuthorized({ ...scope, visibility: 'aggregate', operations }) ? blockers : [];
  };

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

    const admitted = currentActor();
    if (!admitted) return forbidden();

    if (!hasLegacyFullRead(workflow.store, admitted)) {
      return okEnvelope(
        {
          blockers: transferBlockers(admitted),
          alerts: [],
          recurrences: [],
          categoryRisks: [],
          scopeLimited: true,
        },
        authInfo,
        requestId,
      );
    }

    const connectionId = merchantConnectionId(config);
    let sourceOperations: GovernanceOperation[] = [];
    const captured = await manager.withConnection(async (connected) => {
      if (connected.config.budgetId !== budgetId || connected.budget.id !== budgetId ||
          merchantConnectionId(connected.config) !== connectionId) throw new Error('Selected budget changed');
      const synchronization = z.object({
        snapshot: z.unknown().optional(),
        financialSnapshot: z.unknown().optional(),
      }).parse(connected.synchronization);
      const financialSnapshot = synchronization.financialSnapshot === undefined
        ? undefined : financialSnapshotSchema.parse(synchronization.financialSnapshot);
      const source = canonicalProtocolSnapshotSchema.parse(
        synchronization.snapshot ?? financialSnapshot?.legacySnapshot,
      );
      sourceOperations = financialSourceReadOperations(source);
      const captured = { snapshot: source, ...(financialSnapshot ? { financialSnapshot } : {}) };
      const live = currentActor();
      if (!live || !hasLegacyFullRead(workflow.store, live, sourceOperations))
        throw new ApplicationError({ code: 'FORBIDDEN', message: 'Financial attention is unavailable.' });
      return captured;
    }, { expectedBudgetId: budgetId, dispose: true });
    const live = currentActor();
    if (!live || !hasLegacyFullRead(workflow.store, live, sourceOperations))
      throw new ApplicationError({ code: 'FORBIDDEN', message: 'Financial attention is unavailable.' });
    let authorizeMerchant: (() => boolean) | undefined;
    const merchantActor = live.auth && live.spaceId ? { ...live, auth: live.auth, spaceId: live.spaceId } : null;
    const merchantOptions = merchantActor && merchantAnalysisAuthorized(workflow.store, merchantActor)
      ? { merchantService: await createMerchantIntelligenceService({ store: workflow.store, connectionManager: manager }),
        merchantActor, captureMerchantPublicationAuthority: (authorize: () => boolean) => { authorizeMerchant = authorize; } }
      : undefined;
    const protocol = await createNativeAnalysisProtocol(undefined, merchantOptions);
    const ready = currentActor();
    if (!ready || !hasLegacyFullRead(workflow.store, ready, sourceOperations))
      throw new ApplicationError({ code: 'FORBIDDEN', message: 'Financial attention is unavailable.' });
    const input: CommandInput = {
      args: [], mode: 'observe', actorId: ready.actorId, requestId,
      ledger: { getLatestSynchronization: () => captured }, freshness: null, analysisProtocol: protocol,
    };
    const envelope = await attentionHomeAnalysis(input, params);
    const finalConfig = await manager.loadConfig();
    const finalActor = currentActor();
    if (!finalActor || !hasLegacyFullRead(workflow.store, finalActor, sourceOperations) ||
        (authorizeMerchant && !authorizeMerchant())) return forbidden();
    if (!finalConfig || finalConfig.budgetId !== budgetId || merchantConnectionId(finalConfig) !== connectionId) {
      setResponseStatus(event, 409);
      return errorEnvelope('SPACE_CONNECTION_MISMATCH', 'The selected connection changed.', authInfo, false, requestId);
    }

    if (envelope.status === 'ok') {
      const sanitized = z.object({ blockers: z.array(z.unknown()) }).passthrough().parse(
        sanitizeCanonicalEvidence(envelope.result),
      );
      const result = { ...sanitized, blockers: [...sanitized.blockers, ...transferBlockers(finalActor)] };
      if (!hasLegacyFullRead(workflow.store, finalActor, attentionDisclosureOperations(result))) return forbidden();
      return okEnvelope(result, authInfo, envelope.requestId, envelopeMetadata(envelope));
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
    if (errorHasCode(error, 'FORBIDDEN')) return forbidden();
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
