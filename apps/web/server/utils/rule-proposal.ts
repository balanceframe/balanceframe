import type { AutomationRule, BudgetLedger } from '@balanceframe/actual-adapter';
import {
  GENERIC_MUTATION_POLICY_VERSION,
  ProposalAcquisitionError,
  canonicalProposalJson,
  deriveActualRuleCategoryGroupReferences,
} from '@balanceframe/workflow-store';
import type { H3Event } from 'h3';
import { readBody, setHeader, setResponseStatus } from 'h3';
import { z } from 'zod';
import { createMutationConnectionManager } from './mutation-executor';
import { buildProposalApprovalView } from './proposal-approval-view';
import { hasTrustedRequestOrigin } from './reauthentication';
import type { ReauthenticationEvent } from './reauthentication';
import { requireSelectedSpace } from './space-context';
import type { EventWithContext } from './workflow-store';
import {
  classifyConnectionError,
  errorEnvelope,
  getWorkflowStore,
  okEnvelope,
  recordReadAdmission,
  sanitizeError,
} from './workflow-store';

const RuleId = z.string().trim().min(1).max(200);
const UpdateBody = z.object({ inactive: z.boolean() }).strict();
type RuleMutation = 'update_rule' | 'delete_rule';
type RuleSnapshot = Pick<AutomationRule,
  'id' | 'name' | 'order' | 'trigger' | 'actions' | 'inactive' | 'stage' | 'conditionsOp'>;
const emptyComposite = {
  operations: [], reallocations: [], transferRecommendations: [], ledgerProjections: [], evidenceReferences: [],
};

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

function snapshotRule(rule: AutomationRule): RuleSnapshot | null {
  if (
    typeof rule.id !== 'string' || !rule.id ||
    typeof rule.name !== 'string' ||
    typeof rule.order !== 'number' || !Number.isFinite(rule.order) ||
    !Array.isArray(rule.trigger) || !Array.isArray(rule.actions) ||
    typeof rule.inactive !== 'boolean' ||
    (rule.stage !== 'pre' && rule.stage !== null && rule.stage !== 'post') ||
    (rule.conditionsOp !== 'and' && rule.conditionsOp !== 'or')
  ) return null;
  const snapshot: RuleSnapshot = {
    id: rule.id,
    name: rule.name,
    order: rule.order,
    trigger: rule.trigger,
    actions: rule.actions,
    inactive: rule.inactive,
    stage: rule.stage,
    conditionsOp: rule.conditionsOp,
  };
  try {
    canonicalProposalJson(snapshot);
  } catch {
    return null;
  }
  return snapshot;
}

async function currentCategoryGroupMembers(
  ledger: BudgetLedger,
  groupIds: readonly string[],
): Promise<Record<string, readonly string[]> | null> {
  if (groupIds.length === 0) return {};
  const current = await ledger.getRuleCategoryGroupMembers();
  const referenced = Object.create(null) as Record<string, readonly string[]>;
  for (const groupId of groupIds) {
    if (!Object.hasOwn(current, groupId)) return null;
    const categoryIds = current[groupId];
    if (!Array.isArray(categoryIds) || categoryIds.some((id) => typeof id !== 'string' || !id) ||
        new Set(categoryIds).size !== categoryIds.length) return null;
    referenced[groupId] = [...categoryIds].sort();
  }
  return referenced;
}

/** Creates an exact, pending proposal; execution is exclusively handled by proposal approval routes. */
export async function proposeRuleMutation(
  event: H3Event,
  mutation: RuleMutation,
) {
  const requestId = crypto.randomUUID();
  const context = event as unknown as EventWithContext;
  context.context.requestId = requestId;
  setHeader(event, 'X-BalanceFrame-Request-ID', requestId);
  setHeader(event, 'Cache-Control', 'private, no-store');
  if (!hasTrustedRequestOrigin(event as unknown as ReauthenticationEvent))
    return fail(event, requestId, 403, 'FORBIDDEN', 'Rule proposal is unavailable.');

  const selected = await requireSelectedSpace(context);
  if (!selected.ok) return selected.response;
  const budgetId = selected.space.budgetId;
  let inactive = false;
  if (!budgetId)
    return fail(event, requestId, 409, 'SPACE_BUDGET_REQUIRED', 'The selected space has no bound budget.');

  const params = event.context.params as Record<string, unknown> | undefined;
  const parsedId = RuleId.safeParse(params?.id);
  if (!parsedId.success)
    return fail(event, requestId, 400, 'MISSING_RULE_ID', 'Rule ID is required.');
  const ruleId = parsedId.data;

  let body: unknown;
  try {
    body = await readBody<unknown>(event);
  } catch {
    return fail(event, requestId, 400, 'INVALID_BODY', 'The rule request body is invalid.');
  }
  if (mutation === 'update_rule') {
    const parsed = UpdateBody.safeParse(body);
    if (!parsed.success)
      return fail(event, requestId, 400, 'INVALID_BODY', 'Expected only an inactive boolean.');
    inactive = parsed.data.inactive;
  } else if (body !== undefined) {
    return fail(event, requestId, 400, 'INVALID_BODY', 'Delete rule requests must have an empty body.');
  }

  const workflow = getWorkflowStore(context);
  if ('error' in workflow)
    return fail(event, requestId, 503, 'STORE_UNAVAILABLE', 'Rule proposals are unavailable.');
  const policy = workflow.store.governance.getPolicy({ spaceId: selected.space.id });
  if (!policy)
    return fail(event, requestId, 403, 'FORBIDDEN', 'Rule proposal is unavailable.');
  const inspection = workflow.store.governance.authorizeRuleInspection({
    actorId: selected.auth.actorId,
    auth: selected.auth,
    spaceId: selected.space.id,
    membershipId: selected.membership.id,
    expectedPolicyVersion: policy.version,
    budgetId,
    ruleId,
    operation: mutation,
    now: new Date().toISOString(),
  });
  if (!inspection.inspectionAllowed || !inspection.membershipId || !inspection.policyVersion)
    return fail(event, requestId, 403, 'FORBIDDEN', 'Rule proposal is unavailable.');
  const authorizationInfo = {
    actorId: inspection.actorId,
    capability: 'rule:propose',
    allowed: true,
  };

  try {
    await recordReadAdmission(context, workflow.store, {
      actorId: inspection.actorId,
      spaceId: selected.space.id,
      membershipId: inspection.membershipId,
      budgetId,
      policyVersion: inspection.policyVersion,
      capability: 'rule:propose',
      resourceKind: 'rule',
      resourceId: ruleId,
      operation: mutation,
      phase: 'propose',
      auth: selected.auth,
    });
    const override = await workflow.store.getRuleOverride({
      spaceId: selected.space.id,
      budgetId,
      ruleId,
    });
    const manager = createMutationConnectionManager({ configPath: process.env.BALANCEFRAME_CONFIG_PATH });
    const config = await manager.loadConfig();
    if (!config || config.budgetId !== budgetId)
      return fail(event, requestId, 409, 'SPACE_CONNECTION_MISMATCH', 'The configured budget does not match the selected space.', authorizationInfo);
    return await manager.withConnection(async (connected) => {
      if (connected.config.budgetId !== budgetId || connected.budget.id !== budgetId)
        return fail(event, requestId, 409, 'SPACE_CONNECTION_MISMATCH', 'The connected budget does not match the selected space.', authorizationInfo);

      const ledger = connected.connector as unknown as BudgetLedger;
      const version = z.object({ snapshot: z.object({ actualVersion: z.string().min(1) }) })
        .safeParse(connected.synchronization);
      if (!version.success)
        return fail(event, requestId, 409, 'RULE_SNAPSHOT_INCOMPLETE', 'The current Actual version is unavailable.', authorizationInfo);
      const rules = await ledger.listRules();
      const current = rules.find((rule) => rule.id === ruleId);
      if (!current)
        return fail(event, requestId, 404, 'RULE_NOT_FOUND', 'Rule not found.', authorizationInfo);
      const rule = snapshotRule(current);
      if (!rule)
        return fail(event, requestId, 409, 'RULE_SNAPSHOT_INCOMPLETE', 'The current rule snapshot is incomplete.', authorizationInfo);

      let groupIds: string[];
      try {
        groupIds = deriveActualRuleCategoryGroupReferences(rule.trigger);
      } catch {
        return fail(event, requestId, 409, 'RULE_SNAPSHOT_INCOMPLETE', 'The current rule predicates are incomplete.', authorizationInfo);
      }
      let categoryGroupMembers: Record<string, readonly string[]> | null = {};
      if (groupIds.length > 0) {
        categoryGroupMembers = await currentCategoryGroupMembers(ledger, groupIds);
        if (!categoryGroupMembers)
          return fail(event, requestId, 409, 'RULE_SNAPSHOT_INCOMPLETE', 'Current category-group membership is unavailable.', authorizationInfo);
      }

      const payload = mutation === 'update_rule'
        ? { kind: 'update_rule' as const, ruleId, inactive, composite: emptyComposite }
        : { kind: 'delete_rule' as const, ruleId, composite: emptyComposite };
      const preconditions = {
        rule,
        override,
        actualVersion: version.data.snapshot.actualVersion,
        ...(groupIds.length > 0 ? { categoryGroupMembers } : {}),
      };
      // Inspection admits no mutation; Native rechecks the complete before-rule scope before persisting.
      const proposal = await workflow.store.createProposal({
        operation: payload.kind,
        budgetId,
        spaceId: selected.space.id,
        payload,
        policyVersion: GENERIC_MUTATION_POLICY_VERSION,
        preconditions: canonicalProposalJson(preconditions),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        actorId: selected.auth.actorId,
        auth: selected.auth,
        provenance: 'rule-route',
        correlationId: requestId,
      });
      const proposalView = await buildProposalApprovalView({
        store: workflow.store,
        proposal,
        actorId: selected.auth.actorId,
        auth: selected.auth,
        now: new Date().toISOString(),
        requestId,
      });
      if (!proposalView)
        return fail(event, requestId, 409, 'PROPOSAL_UNAVAILABLE', 'A current rule proposal could not be read.', authorizationInfo);

      return okEnvelope({
        proposal: proposalView,
        state: 'approval_required' as const,
        applied: false as const,
        verified: false as const,
      }, authorizationInfo, requestId);
    }, { expectedBudgetId: budgetId, dispose: true });
  } catch (error) {
    if (event.node.res.headersSent) throw error;
    const connectionError = classifyConnectionError(error);
    if (connectionError)
      return fail(event, requestId, 503, connectionError.code, connectionError.message, authorizationInfo, connectionError.retryable);
    if (error instanceof ProposalAcquisitionError && error.reasonCode === 'authorization_denied')
      return fail(event, requestId, 403, 'FORBIDDEN', 'Complete rule proposal authority is unavailable.', authorizationInfo);
    const safe = sanitizeError(error, requestId, 'RULE_PROPOSAL_FAILED', true);
    return fail(event, requestId, safe.code === 'not_connected' ? 503 : 409, safe.code, 'A current rule proposal could not be created.', authorizationInfo, safe.retryable);
  }
}
