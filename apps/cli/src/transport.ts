import { ErrorInfo, errorResponse } from '@balanceframe/application/envelope';
import { merchantPolicyViewSchema, merchantResearchPreviewSchema, merchantResearchOutcomeSchema, merchantResearchCacheSchema, merchantResearchPolicyViewSchema } from '@balanceframe/application';
import type { CliCommand } from './index.js';
import { z } from 'zod';

const merchantResponseSchemas: Record<string, z.ZodType> = {
  '/api/merchant/research/preview': merchantResearchPreviewSchema,
  '/api/merchant/research': merchantResearchOutcomeSchema,
  '/api/merchant/research/cache': merchantResearchCacheSchema,
  '/api/merchant/research/policy': merchantResearchPolicyViewSchema,
  '/api/merchant/space-policy': merchantPolicyViewSchema,
};
const authorizationSchema = z
  .object({ actorId: z.string().min(1), capability: z.string().min(1), allowed: z.boolean() })
  .nullable();
const freshnessSchema = z
  .object({
    actualDownloadedAt: z.string().nullable(),
    bankSyncedAt: z.string().nullable(),
    pendingTransactionsIncluded: z.boolean(),
    stalenessDays: z.number().finite(),
    isStale: z.boolean(),
  })
  .nullable();
const errorSchema = z
  .object({ code: z.string().min(1), message: z.string(), retryable: z.boolean() })
  .nullable();
const envelopeSchema = z
  .object({
    schemaVersion: z.literal('1'),
    requestId: z.string().min(1),
    status: z.enum(['ok', 'error']),
    dataFreshness: freshnessSchema,
    authorization: authorizationSchema,
    result: z.unknown(),
    error: errorSchema,
    scope: z.record(z.string(), z.unknown()).optional(),
    semanticClasses: z.array(z.string()).optional(),
    evidence: z
      .array(z.object({ source: z.string(), id: z.string(), weight: z.number().finite() }))
      .optional(),
    policyVersion: z.string().optional(),
  })
  .passthrough()
  .superRefine((envelope, context) => {
    if (!Object.hasOwn(envelope, 'result')) {
      context.addIssue({ code: 'custom', message: 'Missing result.' });
    }
    if ((envelope.status === 'ok') !== (envelope.error === null)) {
      context.addIssue({ code: 'custom', message: 'Envelope status and error disagree.' });
    }
    if (envelope.status === 'error' && envelope.result !== null) {
      context.addIssue({ code: 'custom', message: 'Error envelopes must have a null result.' });
    }
    if (envelope.status === 'ok' && envelope.result === null) {
      context.addIssue({ code: 'custom', message: 'Success envelopes must have a result.' });
    }
  });

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
type Query = Record<string, string | number | boolean | undefined>;
type SpaceHeader = { kind: 'selected' } | { kind: 'none' } | { kind: 'explicit'; id: string };

function cliError(requestId: string, code: string, message: string, retryable = false): string {
  return JSON.stringify(
    errorResponse(
      requestId,
      new ErrorInfo({ code, message, retryable, reasonCodes: [code] }),
    ),
    null,
    2,
  );
}

function responseText(value: unknown, secrets: string[]): string {
  let text = JSON.stringify(value, null, 2) ?? '';
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join('[redacted]');
  }
  return text;
}

function credentialSecrets(apiKey: string, sessionCookie: string): string[] {
  const cookieValues = sessionCookie
    .split(';')
    .map((part) => part.trim().split('=').slice(1).join('='))
    .filter(Boolean);
  return [apiKey, sessionCookie, ...cookieValues].filter(Boolean);
}

function objectJsonOption(
  requestId: string,
  option: string,
  source: string | undefined,
): { value: Record<string, unknown> } | { error: string } {
  if (source === undefined) return { value: {} };
  try {
    const parsed: unknown = JSON.parse(source);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not_object');
    }
    return { value: parsed as Record<string, unknown> };
  } catch {
    return { error: cliError(requestId, 'invalid_json_option', `--${option} must be a JSON object.`) };
  }
}

function optionBody(
  options: Record<string, string> | undefined,
  fields: Record<string, string>,
): Record<string, string> {
  const body: Record<string, string> = {};
  for (const [option, field] of Object.entries(fields)) {
    const value = options?.[option];
    if (value !== undefined) body[field] = value;
  }
  return body;
}

function selectedSpace(): string | undefined {
  const configured = process.env.BALANCEFRAME_SPACE_ID?.trim();
  if (configured) return configured;
  const cookie = process.env.BALANCEFRAME_SESSION_COOKIE ?? '';
  for (const part of cookie.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === 'balanceframe_space') {
      try {
        return decodeURIComponent(value.join('=')) || undefined;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

async function send(
  requestId: string,
  path: string,
  method: Method,
  options: { query?: Query; body?: unknown; space?: SpaceHeader; humanControl?: boolean } = {},
): Promise<string> {
  const serverUrl = process.env.BALANCEFRAME_SERVER_URL?.trim();
  const apiKey = process.env.BALANCEFRAME_API_KEY?.trim() ?? '';
  const sessionCookie = process.env.BALANCEFRAME_SESSION_COOKIE?.trim() ?? '';
  if (!serverUrl) {
    return cliError(requestId, 'server_url_required', 'Set BALANCEFRAME_SERVER_URL to the BalanceFrame server.');
  }
  if (options.humanControl && !sessionCookie) {
    return cliError(
      requestId,
      'human_session_required',
      'A human session cookie with current reauthentication is required for this operation.',
    );
  }
  if (!apiKey && !sessionCookie) {
    return cliError(
      requestId,
      'server_auth_required',
      'Set BALANCEFRAME_API_KEY or BALANCEFRAME_SESSION_COOKIE to authenticate with BalanceFrame.',
    );
  }
  if (/\r|\n/.test(apiKey) || /\r|\n/.test(sessionCookie)) {
    return cliError(requestId, 'invalid_server_auth', 'The configured BalanceFrame credential is invalid.');
  }

  let base: URL;
  try {
    base = new URL(serverUrl);
  } catch {
    return cliError(requestId, 'invalid_server_url', 'BALANCEFRAME_SERVER_URL must be a valid URL.');
  }
  if (
    (base.protocol !== 'https:' && base.protocol !== 'http:') ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    (base.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))
  ) {
    return cliError(requestId, 'invalid_server_url', 'BALANCEFRAME_SERVER_URL must use HTTPS.');
  }

  const space = options.space ?? { kind: 'selected' as const };
  const selected = space.kind === 'explicit' ? space.id : space.kind === 'selected' ? selectedSpace() : undefined;
  if (space.kind === 'selected' && !selected) {
    return cliError(
      requestId,
      'space_selection_required',
      'Set BALANCEFRAME_SPACE_ID to select a space before using this command.',
    );
  }
  if (space.kind === 'explicit' && !space.id) {
    return cliError(requestId, 'space_selection_required', 'Select a space before using this command.');
  }

  const url = new URL(path, `${base.origin}/`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  let headers: Headers;
  try {
    headers = new Headers({ accept: 'application/json' });
    if (options.humanControl || !apiKey) headers.set('cookie', sessionCookie);
    else headers.set('authorization', `Bearer ${apiKey}`);
    if (selected) headers.set('X-BalanceFrame-Space', selected);
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    if (merchantResponseSchemas[path] && (method === 'POST' || method === 'PUT')) headers.set('origin', base.origin);
  } catch {
    return cliError(requestId, 'invalid_server_auth', 'The configured BalanceFrame credential or space is invalid.');
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      redirect: 'error',
    });
  } catch {
    return cliError(requestId, 'server_unavailable', 'The BalanceFrame server request failed.', true);
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return cliError(requestId, 'invalid_server_response', 'The BalanceFrame server returned invalid JSON.');
  }
  const parsed = envelopeSchema.safeParse(json);
  if (!parsed.success) {
    return cliError(
      requestId,
      'invalid_server_response',
      'The BalanceFrame server returned an invalid response envelope.',
    );
  }
  const envelope = parsed.data;
  if (envelope.status === 'ok' && !response.ok) {
    return cliError(
      requestId,
      'invalid_server_response',
      'The BalanceFrame server returned a success envelope with an error HTTP status.',
    );
  }
  if (envelope.status === 'error' && !envelope.error) {
    return cliError(requestId, 'invalid_server_response', 'The BalanceFrame server returned an invalid error envelope.');
  }
  const resultSchema = merchantResponseSchemas[path];
  if (envelope.status === 'ok' && resultSchema) {
    const result = resultSchema.safeParse(envelope.result);
    if (!result.success) return cliError(requestId, 'invalid_server_response', 'The BalanceFrame server returned an invalid merchant response.');
    envelope.result = result.data;
  }
  return responseText(envelope, credentialSecrets(apiKey, sessionCookie));
}

function queryOptions(options: Record<string, string> | undefined, fields: Record<string, string>): Query {
  const query: Query = {};
  for (const [option, field] of Object.entries(fields)) {
    const value = options?.[option];
    if (value !== undefined) query[field] = value;
  }
  return query;
}

/**
 * Execute a parsed CLI command through the authenticated server transport.
 */
export async function runServerCommand(cmd: CliCommand, requestId: string): Promise<string> {
  const options = cmd.options ?? {};
  const selected = selectedSpace();
  const spacePath = selected ? `/api/spaces/${encodeURIComponent(selected)}` : '/api/spaces';
  const post = (
    path: string,
    body?: unknown,
    space: SpaceHeader = { kind: 'selected' },
    humanControl = false,
  ) => send(requestId, path, 'POST', { body, space, humanControl });
  const put = (path: string, body: unknown, humanControl = false) =>
    send(requestId, path, 'PUT', { body, humanControl });
  const get = (
    path: string,
    query?: Query,
    space: SpaceHeader = { kind: 'selected' },
    humanControl = false,
  ) => send(requestId, path, 'GET', { query, space, humanControl });

  switch (cmd.command) {
    case 'merchant.analyze':
    case 'merchant.evidence':
      return get('/api/merchant', queryOptions(options, { 'transaction-id': 'transactionId', cursor: 'cursor', limit: 'limit', 'facts-hash': 'factsHash' }));
    case 'merchant.research.policy':
      return get('/api/merchant/research/policy');
    case 'merchant.research.preview':
    case 'merchant.research.send':
    case 'merchant.research.cache': {
      const body = {
        ...optionBody(options, { 'evidence-key': 'evidenceKey', 'evidence-revision': 'evidenceRevision', merchant: 'merchant' }),
        locale: options.locale ?? null,
        publicBusiness: true,
        ...(cmd.command === 'merchant.research.send' ? { previewToken: options['preview-token'], consent: true, idempotencyKey: options['idempotency-key'] } : {}),
      };
      const path = cmd.command === 'merchant.research.send' ? '/api/merchant/research'
        : cmd.command === 'merchant.research.preview' ? '/api/merchant/research/preview' : '/api/merchant/research/cache';
      return post(path, body);
    }
    case 'merchant.space-policy.get':
      return get('/api/merchant/space-policy');
    case 'merchant.space-policy.set': {
      const policy = objectJsonOption(requestId, 'policy', options.policy);
      if ('error' in policy) return policy.error;
      return put('/api/merchant/space-policy', { expectedVersion: Number(options['expected-version']), value: policy.value }, true);
    }
    case 'merchant.confirm':
    case 'merchant.reject': {
      const body = {
        ...optionBody(options, { id: 'id', kind: 'kind', 'evidence-key': 'evidenceKey', 'evidence-revision': 'evidenceRevision', visibility: 'visibility' }),
        expectedVersion: Number(options['expected-version']),
        ...(options.kind === 'alias' ? {
          transactionId: options['transaction-id'], sourceField: options['source-field'], targetPayeeId: options['target-payee-id'],
          accountId: options['account-id'] === 'null' ? null : options['account-id'],
        } : { patternId: options['pattern-id'] }),
      };
      return post(`/api/merchant/${cmd.command === 'merchant.confirm' ? 'confirm' : 'reject'}`, body, { kind: 'selected' }, true);
    }
    case 'merchant.policy.get':
      return get('/api/merchant/policy');
    case 'merchant.policy.set': {
      const policy = objectJsonOption(requestId, 'policy', options.policy);
      if ('error' in policy) return policy.error;
      return put('/api/merchant/policy', { expectedVersion: Number(options['expected-version']), value: policy.value }, true);
    }
    case 'merchant.calendar':
      return get('/api/merchant/calendar', { accountId: options['account-id'], year: options.year });
    case 'merchant.export':
      return get('/api/merchant/export', undefined, { kind: 'selected' }, true);
    case 'merchant.delete':
      return send(requestId, '/api/merchant', 'DELETE', { humanControl: true });
    case 'spaces.list':
      return get('/api/spaces', undefined, { kind: 'none' });
    case 'spaces.create':
      return post('/api/spaces', { name: options.name, kind: options.kind }, { kind: 'none' }, true);
    case 'spaces.select': {
      const spaceId = options.spaceId ?? '';
      return post(`/api/spaces/${encodeURIComponent(spaceId)}/select`, {}, { kind: 'explicit', id: spaceId }, true);
    }
    case 'spaces.show':
      return get(spacePath);
    case 'spaces.policy.get':
      return get(`${spacePath}/policy`);
    case 'spaces.policy.set': {
      const policy = objectJsonOption(requestId, 'policy', options.policy);
      if ('error' in policy) return policy.error;
      const expectedVersion = options['expected-version'];
      return put(
        `${spacePath}/policy`,
        { expectedVersion: expectedVersion === 'null' ? null : (expectedVersion ?? null), policy: policy.value },
        true,
      );
    }
    case 'spaces.memberships.list':
      return get(`${spacePath}/memberships`);
    case 'spaces.memberships.create':
      return post(
        `${spacePath}/memberships`,
        {
          actorId: options['member-id'],
          validFrom: options['valid-from'],
          ...(options['valid-until'] ? { validUntil: options['valid-until'] } : {}),
        },
        { kind: 'selected' },
        true,
      );
    case 'spaces.memberships.revoke':
      return post(
        `${spacePath}/memberships/${encodeURIComponent(options.membershipId ?? '')}/revoke`,
        {},
        { kind: 'selected' },
        true,
      );
    case 'spaces.grants.list':
      return get(`${spacePath}/grants`);
    case 'spaces.grants.set':
    case 'spaces.grants.revoke': {
      const restrictions = objectJsonOption(requestId, 'restrictions', options.restrictions);
      if ('error' in restrictions) return restrictions.error;
      return put(
        `${spacePath}/grants`,
        {
          membershipId: options['membership-id'],
          capability: options.capability,
          resourceKind: options['resource-kind'],
          resourceId: options['resource-id'],
          granted: cmd.command === 'spaces.grants.revoke' ? false : options.granted === 'true',
          ...(options.restrictions ? { restrictions: restrictions.value } : {}),
        },
        true,
      );
    }
    case 'spaces.delegations.list':
      return get(`${spacePath}/delegations`);
    case 'spaces.delegations.create': {
      let rights: unknown;
      try {
        rights = JSON.parse(options.rights ?? '');
      } catch {
        return cliError(requestId, 'invalid_json_option', '--rights must be valid JSON.');
      }
      return post(
        `${spacePath}/delegations`,
        {
          agentId: options['agent-id'],
          issuerMembershipId: options['issuer-membership-id'],
          expectedVersion: options['expected-version'] === 'null' ? null : options['expected-version'],
          rights,
          validFrom: options['valid-from'],
          ...(options['valid-until'] ? { validUntil: options['valid-until'] } : {}),
        },
        { kind: 'selected' },
        true,
      );
    }
    case 'spaces.delegations.revoke':
      return post(
        `${spacePath}/delegations/${encodeURIComponent(options.delegationId ?? '')}/revoke`,
        { expectedVersion: options['expected-version'] },
        { kind: 'selected' },
        true,
      );
    case 'spaces.agents.register':
      return post(`${spacePath}/agents`, { agentId: options['agent-id'] }, { kind: 'selected' }, true);
    case 'spaces.credentials.list':
      return get(`${spacePath}/credentials`);
    case 'spaces.credentials.register':
      return post(
        `${spacePath}/credentials`,
        {
          credentialId: options['credential-id'],
          principalType: options['principal-type'],
          principalId: options['principal-id'],
          ...(options['delegation-id'] ? { delegationId: options['delegation-id'] } : {}),
          ...(options['expected-delegation-version']
            ? { expectedDelegationVersion: options['expected-delegation-version'] }
            : {}),
        },
        { kind: 'selected' },
        true,
      );
    case 'spaces.credentials.revoke':
      return post(
        `${spacePath}/credentials/${encodeURIComponent(options['credential-id'] ?? '')}/revoke`,
        {},
        { kind: 'selected' },
        true,
      );
    case 'transactions.pending-review':
      return get('/api/review');
    case 'reviews.show':
      return get(`/api/review/${encodeURIComponent(cmd.reviewId ?? '')}`);
    case 'reviews.approve':
      return post('/api/review/approve', { reviewId: cmd.reviewId }, { kind: 'selected' }, true);
    case 'reviews.correct':
      return post('/api/review/correct', { reviewId: cmd.reviewId, categoryId: cmd.categoryId });
    case 'reviews.reject':
      return post('/api/review/reject', { reviewId: cmd.reviewId });
    case 'reviews.skip':
      return post('/api/review/skip', { reviewId: cmd.reviewId });
    case 'reviews.undo':
      return post('/api/review/undo', { reviewId: cmd.reviewId });
    case 'reviews.approve-bulk': {
      const ids = cmd.ids ?? [];
      const parsedHashes = objectJsonOption(requestId, 'payload-hashes', options['payload-hashes']);
      if ('error' in parsedHashes) return parsedHashes.error;
      const payloadHashes = parsedHashes.value;
      if (
        ids.length === 0 ||
        new Set(ids).size !== ids.length ||
        Object.keys(payloadHashes).length !== ids.length ||
        ids.some((id) => typeof payloadHashes[id] !== 'string' || payloadHashes[id]!.length === 0)
      ) {
        return cliError(
          requestId,
          'invalid_payload_hashes',
          '--payload-hashes must contain one non-empty displayed hash for every unique REVIEW_ID.',
        );
      }
      return post('/api/review/approve-bulk', { ids, payloadHashes }, { kind: 'selected' }, true);
    }
    case 'reviews.group':
      return post('/api/review/group', { ids: cmd.ids ?? [] });
    case 'budget.list':
      return get('/api/connection/budgets', undefined, { kind: 'selected' }, true);
    case 'connect':
      return post('/api/connection', { budgetId: options.budgetId }, { kind: 'selected' }, true);
    case 'budget.summary':
      return get('/api/home/budget-summary');
    case 'export':
      return post('/api/lifecycle/export', undefined, { kind: 'selected' }, true);
    case 'disconnect':
      return post('/api/lifecycle/disconnect', undefined, { kind: 'selected' }, true);
    case 'remove-connection':
      return post('/api/lifecycle/remove-connection', undefined, { kind: 'selected' }, true);
    case 'delete-data':
      return post('/api/lifecycle/delete-data', { scope: options.scope }, { kind: 'selected' }, true);
    case 'proposals.create':
      return post(
        '/api/proposal',
        optionBody(options, {
          'category-id': 'categoryId',
          'transaction-id': 'transactionId',
          message: 'message',
          reason: 'reason',
          operation: 'operation',
        }),
      );
    case 'proposals.show':
      return get(`/api/proposal/${encodeURIComponent(cmd.proposalId ?? '')}`);
    case 'proposals.approve':
      return post(
        `/api/proposal/${encodeURIComponent(cmd.proposalId ?? '')}/approve`,
        { payloadHash: options['payload-hash'] },
        { kind: 'selected' },
        true,
      );
    case 'proposals.execute':
      return post(`/api/proposal/${encodeURIComponent(cmd.proposalId ?? '')}/execute`);
    case 'proposals.list':
      return get('/api/proposal');
    case 'audit.query':
      return get(
        `${spacePath}/audit`,
        queryOptions(options, {
          'actor-id': 'actorId',
          'entity-id': 'entityId',
          action: 'action',
          from: 'from',
          to: 'to',
          limit: 'limit',
          offset: 'offset',
        }),
      );
    case 'rules.create':
      return post(
        '/api/rule',
        optionBody(options, {
          name: 'name',
          'payee-id': 'payeeId',
          'category-id': 'categoryId',
          'transaction-id': 'transactionId',
          operation: 'operation',
        }),
      );
    case 'rules.list':
      return get('/api/rule');
    case 'rules.show':
      return get(`/api/rule/${encodeURIComponent(cmd.ruleId ?? '')}`);
    case 'purchase.evaluate':
      return get('/api/purchase/evaluate', {
        categoryId: options['category-id'] ?? '',
        amount: options.amount ?? '0',
        currency: options.currency ?? 'USD',
        accountId: options['account-id'],
        purchaseAt: options['purchase-at'],
        requiredBy: options['required-by'],
      });
    case 'cash-flow.project':
      return get('/api/cash-flow/project', {
        months: options.months ?? '3',
        startMonth: options['start-month'],
      });
    case 'target.health':
      return get('/api/targets/health');
    case 'sinking-fund.health':
      return get('/api/sinking-fund/health');
    case 'reports.generate':
      return get('/api/reports/generate', {
        reportType: options['report-type'] ?? '',
        monthRange: options['month-range'] ?? '',
        label: options.label,
        tag: options.tag,
      });
    case 'views.list':
      return get('/api/reports/views');
    case 'views.create': {
      let scope: Record<string, unknown> = {};
      if (options.scope) {
        const parsedScope = objectJsonOption(requestId, 'scope', options.scope);
        if ('error' in parsedScope) {
          return cliError(requestId, 'invalid_scope_json', '--scope must be valid JSON.');
        }
        scope = parsedScope.value;
      }
      return post('/api/reports/views', {
        name: options.name ?? '',
        viewType: options['view-type'] ?? '',
        scope,
        ...(options.sort ? { sort: options.sort } : {}),
      });
    }
    case 'home.attention':
      return get('/api/home/attention', {
        categoryGroup: options['category-group'],
        detailed: options.detailed,
      });
    default:
      return cliError(requestId, 'unsupported_command', `Command '${cmd.command}' has no server API.`);
  }
}
