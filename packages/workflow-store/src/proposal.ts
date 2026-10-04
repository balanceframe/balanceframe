import { createHash } from 'node:crypto';
import type {
  GovernanceAccountScope,
  GovernanceAuthorizationResult,
  GovernanceOperation,
  GovernanceResourceKind,
  GovernanceResourceRef,
} from './governance-types.js';
import type {
  CanonicalProposalEnvelope,
  GenericProposalOperation,
  ProposalAcquisitionReasonCode,
} from './types.js';

/** Current implementation version for generic set-category and rule mutations. */
export const GENERIC_MUTATION_POLICY_VERSION = '1.0';

function normalizedJson(value: unknown, active: object[] = []): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Proposal envelope is not JSON-safe');
    return value;
  }
  if (typeof value !== 'object') throw new Error('Proposal envelope is not JSON-safe');
  if (active.includes(value)) throw new Error('Proposal envelope contains a cycle');
  active.push(value);
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (keys.length !== value.length || keys.some((key, index) => key !== String(index)))
        throw new Error('Proposal envelope contains a sparse or decorated array');
      return value.map((item) => normalizedJson(item, active));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new Error('Proposal envelope contains a non-plain object');
    if (Object.getOwnPropertySymbols(value).length !== 0)
      throw new Error('Proposal envelope contains symbol keys');
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor))
        throw new Error('Proposal envelope contains an accessor');
      Object.defineProperty(output, key, {
        value: normalizedJson(descriptor.value, active),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return output;
  } finally {
    active.pop();
  }
}

/** Deterministic JSON for equality checks and immutable envelope hashing. */
export function canonicalProposalJson(value: unknown): string {
  return JSON.stringify(normalizedJson(value));
}

/** Hashes the complete generic proposal envelope; client hashes are never accepted. */
export function canonicalProposalHash(envelope: CanonicalProposalEnvelope): string {
  return createHash('sha256').update(canonicalProposalJson(envelope)).digest('hex');
}

/** Returns current governance approval count with the generic human floor applied. */
export function requiredProposalApprovers(result: GovernanceAuthorizationResult): number {
  return Math.max(1, result.requiredApprovers);
}

/** Safe, classified failure from the proposal execution linearization point. */
export class ProposalAcquisitionError extends Error {
  constructor(readonly reasonCode: ProposalAcquisitionReasonCode, message: string) {
    super(message);
    this.name = 'ProposalAcquisitionError';
  }
}

/** Exact resource scopes and normalized financial effects extracted from a proposal. */
export interface ProposalAuthorizationFacts {
  readonly resources: readonly GovernanceResourceRef[];
  readonly operations: readonly GovernanceOperation[];
}

const RESOURCE_FIELDS: Record<string, GovernanceResourceKind> = {
  accountId: 'account',
  sourceAccountId: 'account',
  destinationAccountId: 'account',
  fromAccountId: 'account',
  toAccountId: 'account',
  transactionId: 'transaction',
  categoryId: 'category',
  sourceCategoryId: 'category',
  destinationCategoryId: 'category',
  ruleId: 'rule',
  evidenceId: 'evidence',
  walletId: 'wallet',
  receiptId: 'receipt',
  commitmentId: 'commitment',
  scenarioId: 'scenario',
  reservationId: 'reservation',
  purchaseId: 'purchase',
  transferId: 'transfer',
  transferRecommendationId: 'transfer',
  sessionId: 'session',
  proposalId: 'proposal',
  ledgerEffectId: 'ledger_effect',
};

const VALID_RESOURCE_KINDS: Record<string, true> = {
  space: true,
  budget: true,
  account: true,
  category: true,
  transaction: true,
  rule: true,
  evidence: true,
  wallet: true,
  receipt: true,
  commitment: true,
  scenario: true,
  reservation: true,
  purchase: true,
  transfer: true,
  ledger_effect: true,
  session: true,
  proposal: true,
};

function proposalRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function proposalText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new Error(`Missing server-derived ${label}`);
  return value;
}

function proposalMoney(value: unknown): { minorUnits: string; currency: string } {
  const money = proposalRecord(value);
  if (!money || typeof money.minorUnits !== 'string' || !/^(0|[1-9]\d*)$/.test(money.minorUnits) ||
      typeof money.currency !== 'string' || !/^[A-Z]{3}$/.test(money.currency))
    throw new Error('Invalid server-derived proposal amount');
  return { minorUnits: money.minorUnits, currency: money.currency };
}

function collectProposalResources(
  value: unknown,
  resources: Record<string, GovernanceResourceRef>,
  allowEmptyReviewProvenanceCategory = false,
  preconditionsRoot = false,
): void {
  if (Array.isArray(value)) {
    for (const child of value) collectProposalResources(child, resources);
    return;
  }
  const object = proposalRecord(value);
  if (!object) return;
  if (object.resourceKind !== undefined || object.resourceId !== undefined) {
    let kind: string | undefined;
    if (object.resourceKind !== undefined) {
      if (typeof object.resourceKind !== 'string') throw new Error('Invalid proposal resource kind');
      kind = object.resourceKind;
    } else if (object.kind === 'category') {
      kind = 'category';
    } else if (object.kind === 'account_debit' || object.kind === 'destination_hold') {
      kind = 'account';
    }
    if (!kind || VALID_RESOURCE_KINDS[kind] !== true)
      throw new Error('Invalid proposal resource kind');
    const resourceId = proposalText(object.resourceId, `${kind} resource`);
    resources[`${kind}:${resourceId}`] = { resourceKind: kind as GovernanceResourceKind, resourceId };
  }
  for (const [field, kind] of Object.entries(RESOURCE_FIELDS)) {
    const id = object[field];
    if (id === undefined || id === null ||
        (allowEmptyReviewProvenanceCategory && field === 'categoryId' && id === '')) continue;
    const resourceId = proposalText(id, `${kind} resource`);
    resources[`${kind}:${resourceId}`] = { resourceKind: kind, resourceId };
  }
  for (const field of Object.keys(object))
    collectProposalResources(object[field], resources, preconditionsRoot && field === 'reviewProvenance');
}

function normalizedGovernanceOperation(
  operation: string,
  source: Record<string, unknown>,
  defaultDirection?: 'incoming' | 'outgoing',
): GovernanceOperation {
  const result: {
    operation: string;
    direction?: 'incoming' | 'outgoing';
    amount?: { minorUnits: string; currency: string };
    accountId?: string;
    sourceAccountId?: string;
    destinationAccountId?: string;
    categoryId?: string;
    sourceCategoryId?: string;
    destinationCategoryId?: string;
    ruleId?: string;
    evidenceId?: string;
    resourceKind?: GovernanceResourceKind;
    resourceId?: string;
  } = { operation };
  const direction = source.direction ?? defaultDirection;
  if (direction !== undefined) {
    if (direction !== 'incoming' && direction !== 'outgoing')
      throw new Error('Invalid server-derived operation direction');
    result.direction = direction;
  }
  if (source.amount !== undefined) result.amount = proposalMoney(source.amount);
  if (result.amount && !result.direction)
    throw new Error('Proposal amount has no normalized direction');
  for (const key of [
    'accountId',
    'sourceAccountId',
    'destinationAccountId',
    'categoryId',
    'sourceCategoryId',
    'destinationCategoryId',
    'ruleId',
    'evidenceId',
  ] as const) {
    if (source[key] !== undefined) result[key] = proposalText(source[key], key);
  }
  if (source.resourceKind !== undefined || source.resourceId !== undefined) {
    if (typeof source.resourceKind !== 'string' || VALID_RESOURCE_KINDS[source.resourceKind] !== true)
      throw new Error('Invalid proposal resource kind');
    result.resourceKind = source.resourceKind as GovernanceResourceKind;
    result.resourceId = proposalText(source.resourceId, `${result.resourceKind} resource`);
  }
  return result;
}

function requireCompositeArray(composite: Record<string, unknown>, key: string): unknown[] {
  const value = composite[key];
  if (!Array.isArray(value)) throw new Error(`Invalid generic proposal composite ${key}`);
  return value;
}

type RuleLifecycleOperation = 'update_rule' | 'delete_rule';

const RULE_SNAPSHOT_FIELDS = [
  'id', 'name', 'order', 'trigger', 'actions', 'inactive', 'stage', 'conditionsOp',
];
const RULE_OVERRIDE_FIELDS = ['ruleId', 'inactive', 'version'];
const RULE_LIFECYCLE_PAYLOAD_FIELDS: Record<RuleLifecycleOperation, readonly string[]> = {
  update_rule: ['kind', 'ruleId', 'inactive', 'composite'],
  delete_rule: ['kind', 'ruleId', 'composite'],
};

function assertOnlyFields(
  record: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): void {
  if (Object.keys(record).some((field) => !fields.includes(field)))
    throw new Error(`Unsupported ${label} field`);
}

function hasOwnField(record: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, field);
}

function addRuleResource(
  resources: Record<string, GovernanceResourceRef>,
  kind: 'account' | 'category' | 'rule',
  value: unknown,
): string {
  const resourceId = proposalText(value, `${kind} resource`);
  resources[`${kind}:${resourceId}`] = { resourceKind: kind, resourceId };
  return resourceId;
}

function addActualRuleCategoryGroupReferences(
  condition: Record<string, unknown>,
  categoryGroups: Set<string>,
): void {
  if (
    condition.op === 'contains' ||
    condition.op === 'doesNotContain' ||
    condition.op === 'matches'
  ) {
    if (typeof condition.value !== 'string')
      throw new Error('Malformed category_group rule name pattern');
    return;
  }
  if (condition.op === 'is' || condition.op === 'isNot') {
    categoryGroups.add(proposalText(condition.value, 'category group resource'));
    return;
  }
  if (condition.op === 'oneOf' || condition.op === 'notOneOf') {
    if (!Array.isArray(condition.value))
      throw new Error('Malformed category_group rule resource list');
    for (const id of condition.value)
      categoryGroups.add(proposalText(id, 'category group resource'));
    return;
  }
  throw new Error('Unsupported category_group rule condition operator');
}

/** Returns the exact category groups referenced by supported Actual rule predicates. */
export function deriveActualRuleCategoryGroupReferences(triggerValue: unknown): string[] {
  if (!Array.isArray(triggerValue)) throw new Error('Malformed Actual rule trigger');

  const categoryGroups = new Set<string>();
  for (const value of triggerValue) {
    const condition = proposalRecord(value);
    if (!condition || typeof condition.field !== 'string' || typeof condition.op !== 'string')
      throw new Error('Malformed Actual rule trigger');
    if (condition.field === 'category_group')
      addActualRuleCategoryGroupReferences(condition, categoryGroups);
  }
  return [...categoryGroups].sort();
}

function collectActualRuleResources(
  rule: Record<string, unknown>,
  resources: Record<string, GovernanceResourceRef>,
): Set<string> {
  const categoryGroups = new Set<string>();
  for (const value of rule.trigger as unknown[]) {
    const condition = proposalRecord(value);
    if (!condition || typeof condition.field !== 'string' || typeof condition.op !== 'string')
      throw new Error('Malformed Actual rule trigger');
    const { field, op } = condition;
    if (field === 'category_group') {
      addActualRuleCategoryGroupReferences(condition, categoryGroups);
      continue;
    }
    if (field !== 'account' && field !== 'category') continue;
    if (field === 'account' && (op === 'onBudget' || op === 'offBudget')) continue;
    if (op === 'contains' || op === 'doesNotContain' || op === 'matches') {
      if (typeof condition.value !== 'string')
        throw new Error(`Malformed ${field} rule name pattern`);
      continue;
    }
    if (op === 'is' || op === 'isNot') {
      if (field === 'category' && condition.value === null) continue;
      addRuleResource(resources, field, condition.value);
      continue;
    }
    if (op === 'oneOf' || op === 'notOneOf') {
      if (!Array.isArray(condition.value))
        throw new Error(`Malformed ${field} rule resource list`);
      for (const id of condition.value) addRuleResource(resources, field, id);
      continue;
    }
    throw new Error(`Unsupported ${field} rule condition operator`);
  }

  for (const value of rule.actions as unknown[]) {
    const action = proposalRecord(value);
    if (!action || typeof action.op !== 'string')
      throw new Error('Malformed Actual rule action');
    if (action.field !== 'account' && action.field !== 'category') continue;
    if (action.op !== 'set')
      throw new Error(`Unsupported Actual ${action.field} rule action`);
    if (action.field === 'category' && action.value === null) continue;
    addRuleResource(resources, action.field, action.value);
  }
  return categoryGroups;
}

function actualRuleAccountScope(rule: Record<string, unknown>): GovernanceAccountScope {
  if (rule.conditionsOp !== 'and' || !Array.isArray(rule.trigger))
    return { kind: 'global' };
  const accountIds = new Set<string>();
  let accountPredicates = 0;
  for (const value of rule.trigger) {
    const condition = proposalRecord(value);
    if (!condition || typeof condition.field !== 'string' || typeof condition.op !== 'string')
      return { kind: 'global' };
    if (condition.field === 'account') {
      if (condition.op === 'is') {
        accountIds.add(proposalText(condition.value, 'account resource'));
        accountPredicates++;
        continue;
      }
      if (condition.op === 'oneOf' && Array.isArray(condition.value)) {
        for (const id of condition.value)
          accountIds.add(proposalText(id, 'account resource'));
        accountPredicates++;
        continue;
      }
      return { kind: 'global' };
    }
    if (condition.field === 'payee_name' && condition.op === 'is' &&
        typeof condition.value === 'string' && condition.value.trim())
      continue;
    if (condition.field === 'category' || condition.field === 'category_group') continue;
    return { kind: 'global' };
  }
  return accountPredicates === 1 && accountIds.size > 0
    ? { kind: 'accounts', accountIds: [...accountIds].sort() }
    : { kind: 'global' };
}

function addCategoryGroupMembers(
  preconditions: Record<string, unknown>,
  categoryGroups: Set<string>,
  resources: Record<string, GovernanceResourceRef>,
): void {
  const hasMembers = hasOwnField(preconditions, 'categoryGroupMembers');
  if (categoryGroups.size === 0) {
    if (hasMembers) {
      const members = proposalRecord(preconditions.categoryGroupMembers);
      if (!members || Object.keys(members).length !== 0)
        throw new Error('Unexpected category-group member closure');
    }
    return;
  }

  const members = proposalRecord(preconditions.categoryGroupMembers);
  if (!members) throw new Error('Missing current category-group member closure');
  const memberGroups = Object.keys(members);
  if (memberGroups.length !== categoryGroups.size || memberGroups.some((id) => !categoryGroups.has(id)))
    throw new Error('Incomplete category-group member closure');

  for (const groupId of categoryGroups) {
    const categories = members[groupId];
    if (!Array.isArray(categories))
      throw new Error('Missing current category-group members');
    const uniqueCategories = new Set<string>();
    for (const categoryValue of categories) {
      const categoryId = proposalText(categoryValue, 'category group member resource');
      if (uniqueCategories.has(categoryId))
        throw new Error('Duplicate category-group member resource');
      uniqueCategories.add(categoryId);
      resources[`category:${categoryId}`] = { resourceKind: 'category', resourceId: categoryId };
    }
  }
}

function deriveRuleLifecycleOperation(
  operation: RuleLifecycleOperation,
  payload: Record<string, unknown>,
  preconditions: Record<string, unknown>,
  resources: Record<string, GovernanceResourceRef>,
): GovernanceOperation {
  if (payload.kind !== operation)
    throw new Error('Rule lifecycle payload kind does not match operation');
  assertOnlyFields(
    payload,
    RULE_LIFECYCLE_PAYLOAD_FIELDS[operation],
    operation === 'delete_rule' ? 'delete_rule replacement payload' : 'update_rule payload',
  );
  const ruleId = addRuleResource(resources, 'rule', payload.ruleId);
  if (operation === 'update_rule' && typeof payload.inactive !== 'boolean')
    throw new Error('Rule inactive target must be a boolean');

  const rule = proposalRecord(preconditions.rule);
  if (!rule) throw new Error('Missing complete current rule snapshot');
  assertOnlyFields(rule, RULE_SNAPSHOT_FIELDS, 'current rule snapshot');
  for (const field of RULE_SNAPSHOT_FIELDS) {
    if (!hasOwnField(rule, field)) throw new Error(`Incomplete current rule snapshot: ${field}`);
  }
  if (proposalText(rule.id, 'rule ID') !== ruleId)
    throw new Error('Current rule snapshot ID does not match the target rule');
  if (typeof rule.name !== 'string')
    throw new Error('Invalid current rule name');
  if (typeof rule.order !== 'number' || !Number.isSafeInteger(rule.order) || rule.order < 0)
    throw new Error('Invalid current rule order');
  if (!Array.isArray(rule.trigger) || !Array.isArray(rule.actions))
    throw new Error('Invalid current rule trigger or actions');
  if (typeof rule.inactive !== 'boolean')
    throw new Error('Invalid current rule inactive state');
  if (rule.stage !== null && rule.stage !== 'pre' && rule.stage !== 'post')
    throw new Error('Invalid current rule stage');
  if (rule.conditionsOp !== 'and' && rule.conditionsOp !== 'or')
    throw new Error('Invalid current rule conditionsOp');

  if (!hasOwnField(preconditions, 'override'))
    throw new Error('Missing exact current rule override state');
  if (preconditions.override !== null) {
    const override = proposalRecord(preconditions.override);
    if (!override) throw new Error('Invalid current rule override state');
    assertOnlyFields(override, RULE_OVERRIDE_FIELDS, 'rule override snapshot');
    if (override.ruleId !== ruleId)
      throw new Error('Rule override ID does not match the target rule');
    if (
      (override.inactive !== null && typeof override.inactive !== 'boolean') ||
      typeof override.version !== 'number' ||
      !Number.isSafeInteger(override.version) ||
      override.version < 1
    )
      throw new Error('Invalid current rule override version or inactive state');
  }

  const categoryGroups = collectActualRuleResources(rule, resources);
  addCategoryGroupMembers(preconditions, categoryGroups, resources);
  return {
    ...normalizedGovernanceOperation(operation, { ruleId }),
    accountScope: actualRuleAccountScope(rule),
  };
}
/** Derives resource coverage and gross/count limits from the exact server proposal envelope. */
export function deriveProposalAuthorizationFacts(
  operation: GenericProposalOperation,
  payloadValue: unknown,
  preconditionsValue: unknown,
): ProposalAuthorizationFacts {
  const payload = proposalRecord(payloadValue);
  const preconditions = proposalRecord(preconditionsValue);
  if (!payload || !preconditions) throw new Error('Malformed generic proposal envelope');
  if (payload.kind !== operation)
    throw new Error('Proposal payload kind does not match operation');

  const resources: Record<string, GovernanceResourceRef> = {};
  collectProposalResources(payload, resources);
  collectProposalResources(preconditions, resources, false, true);

  const composite = payload.composite === undefined ? null : proposalRecord(payload.composite);
  if (payload.composite !== undefined && !composite)
    throw new Error('Malformed generic proposal composite');

  const operations: GovernanceOperation[] = [];
  const transactionFacts =
    proposalRecord(preconditions.transaction) ??
    proposalRecord(preconditions.actualTransaction) ??
    proposalRecord(preconditions.transactionFacts) ??
    preconditions;
  let actualDirection: 'incoming' | 'outgoing' | undefined;
  let actualAmount: { minorUnits: string; currency: string } | undefined;
  let actualAccountId: string | undefined;
  let ruleLifecycleOperation: GovernanceOperation | null = null;
  if (operation === 'set_category') {
    actualAccountId = proposalText(transactionFacts.accountId, 'transaction account');
    actualAmount = proposalMoney(transactionFacts.amount);
    if (transactionFacts.direction !== 'incoming' && transactionFacts.direction !== 'outgoing')
      throw new Error('Missing server-derived transaction direction');
    actualDirection = transactionFacts.direction;
    resources[`account:${actualAccountId}`] = { resourceKind: 'account', resourceId: actualAccountId };
    const categoryId = proposalText(payload.categoryId, 'target category');
    resources[`category:${categoryId}`] = { resourceKind: 'category', resourceId: categoryId };
  } else if (operation === 'create_rule') {
    const categoryId = proposalText(payload.categoryId, 'target category');
    resources[`category:${categoryId}`] = { resourceKind: 'category', resourceId: categoryId };
    const rule = proposalRecord(payload.rule);
    const conditions = rule?.conditions;
    const actions = rule?.actions;
    if (!rule || !Array.isArray(conditions) || conditions.length !== 1 ||
        !Array.isArray(actions) || actions.length !== 1)
      throw new Error('Unsupported generic rule shape');
    const condition = proposalRecord(conditions[0]);
    const action = proposalRecord(actions[0]);
    if (!condition || condition.field !== 'payee_name' || condition.op !== 'is' ||
        typeof condition.value !== 'string' || !condition.value.trim() ||
        !action || action.type !== 'set-category' || action.field !== 'category' ||
        action.value !== categoryId)
      throw new Error('Unsupported generic rule predicate or action');
  } else {
    ruleLifecycleOperation = deriveRuleLifecycleOperation(operation, payload, preconditions, resources);
  }

  const baseOperation = operation === 'set_category'
    ? normalizedGovernanceOperation(operation, {
        direction: actualDirection,
        amount: actualAmount,
        accountId: actualAccountId,
        categoryId: payload.categoryId,
      })
    : null;
  let baseOperationAdded = false;

  const componentOperations = composite ? requireCompositeArray(composite, 'operations') : [];
  const reallocations = composite ? requireCompositeArray(composite, 'reallocations') : [];
  const transferRecommendations = composite ? requireCompositeArray(composite, 'transferRecommendations') : [];
  const ledgerProjections = composite ? requireCompositeArray(composite, 'ledgerProjections') : [];
  const evidenceReferences = composite ? requireCompositeArray(composite, 'evidenceReferences') : [];

  if (ruleLifecycleOperation) {
    if (
      componentOperations.length > 0 ||
      reallocations.length > 0 ||
      transferRecommendations.length > 0 ||
      ledgerProjections.length > 0 ||
      evidenceReferences.length > 0
    )
      throw new Error('Unsupported executable composite effects for rule lifecycle proposal');
    if (composite) {
      assertOnlyFields(
        composite,
        ['operations', 'reallocations', 'transferRecommendations', 'ledgerProjections', 'evidenceReferences', 'nativePayloadHash'],
        'rule lifecycle composite',
      );
      if (composite.nativePayloadHash !== undefined && typeof composite.nativePayloadHash !== 'string')
        throw new Error('Invalid rule lifecycle composite hash');
    }
    operations.push(ruleLifecycleOperation);
  }

  for (const item of componentOperations) {
    const source = proposalRecord(item);
    if (!source || source.operation !== operation)
      throw new Error('Unsupported generic proposal operation alias');
    const transactionId = source.transactionId;
    const normalized = normalizedGovernanceOperation(operation, source);
    if (transactionId !== undefined) {
      proposalText(transactionId, 'operation transaction');
      if (typeof source.accountId !== 'string')
        throw new Error('Operation transaction lacks its server-derived account');
    }
    if (operation === 'set_category') {
      if (transactionId === undefined || !normalized.accountId || !normalized.categoryId ||
          !normalized.direction || !normalized.amount)
        throw new Error('Set-category operation lacks complete transaction facts');
      if (transactionId === payload.transactionId) {
        if (baseOperationAdded)
          throw new Error('Duplicate base transaction operation');
        if (normalized.accountId !== actualAccountId || normalized.categoryId !== payload.categoryId ||
            normalized.direction !== actualDirection ||
            canonicalProposalJson(source.amount) !== canonicalProposalJson(actualAmount))
          throw new Error('Operation differs from its server-derived transaction facts');
        if (!baseOperation) throw new Error('Missing authoritative base transaction facts');
        operations.push(baseOperation);
        baseOperationAdded = true;
        continue;
      }
    }
    operations.push(operation === 'create_rule'
      ? { ...normalized, accountScope: { kind: 'global' } }
      : normalized);
  }
  if (baseOperation && !baseOperationAdded) operations.push(baseOperation);

  for (const item of reallocations) {
    const source = proposalRecord(item);
    if (!source || source.operation !== undefined && source.operation !== 'reallocation')
      throw new Error('Unsupported reallocation operation alias');
    operations.push(normalizedGovernanceOperation('reallocation', source, 'outgoing'));
  }

  for (const item of transferRecommendations) {
    const plan = proposalRecord(item);
    if (!plan || plan.operation !== undefined && plan.operation !== 'transfer')
      throw new Error('Unsupported transfer operation alias');
    const legs = plan.legs;
    if (!Array.isArray(legs) || legs.length === 0)
      throw new Error('Transfer recommendation has no executable legs');
    for (const leg of legs) {
      const source = proposalRecord(leg);
      if (!source) throw new Error('Malformed transfer recommendation leg');
      operations.push(normalizedGovernanceOperation('transfer', {
        sourceAccountId: source.sourceAccountId,
        destinationAccountId: source.destinationAccountId,
        amount: source.amount,
      }, 'outgoing'));
    }
  }

  for (const item of ledgerProjections) {
    const source = proposalRecord(item);
    if (!source || source.operation !== undefined && source.operation !== 'ledger_projection')
      throw new Error('Unsupported ledger projection operation alias');
    const sameTransaction = source.transactionId === payload.transactionId;
    if (sameTransaction && operation === 'set_category' &&
        (source.accountId !== actualAccountId ||
          source.direction !== undefined && source.direction !== actualDirection ||
          source.amount !== undefined &&
            canonicalProposalJson(proposalMoney(source.amount)) !== canonicalProposalJson(actualAmount)))
      throw new Error('Ledger projection differs from server-derived transaction facts');
    operations.push(normalizedGovernanceOperation(
      'ledger_projection',
      source,
      sameTransaction ? actualDirection : undefined,
    ));
  }

  for (const item of evidenceReferences) {
    const source = proposalRecord(item);
    if (!source || source.operation !== undefined && source.operation !== 'evidence_reference')
      throw new Error('Unsupported evidence operation alias');
    operations.push(normalizedGovernanceOperation('evidence_reference', {
      evidenceId: source.evidenceId,
      resourceKind: source.resourceKind,
      resourceId: source.resourceId,
    }));
  }
  if (operations.length === 0) {
    const operationFact = normalizedGovernanceOperation(operation, { operation });
    operations.push(operation === 'create_rule'
      ? { ...operationFact, accountScope: { kind: 'global' } }
      : operationFact);
  }

  return { resources: Object.values(resources), operations };
}
