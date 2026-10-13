import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, parseArgs } from '../src/index';

type CapturedRequest = { url: URL; method: string; headers: Headers; body: string | undefined };
const okEnvelope = (result: unknown) => ({
  schemaVersion: '1',
  requestId: 'server-request',
  status: 'ok',
  dataFreshness: null,
  authorization: { actorId: 'usr_server_principal', capability: 'observe', allowed: true },
  result,
  error: null,
});
const errorEnvelope = (code: string) => ({
  schemaVersion: '1',
  requestId: 'server-request',
  status: 'error',
  dataFreshness: null,
  authorization: null,
  result: null,
  error: { code, message: 'Server denied this request.', retryable: false },
});

let isolatedDirectory = '';
beforeEach(async () => {
  isolatedDirectory = await mkdtemp(join(tmpdir(), 'balanceframe-cli-transport-'));
});

function setup(
  response: Response | (() => Response) = () =>
    new Response(JSON.stringify(okEnvelope({ items: [], total: 0 }))),
) {
  const requests: CapturedRequest[] = [];
  vi.stubEnv('BALANCEFRAME_SERVER_URL', 'https://balanceframe.example');
  vi.stubEnv('BALANCEFRAME_SPACE_ID', 'spc_selected');
  vi.stubEnv('BALANCEFRAME_API_KEY', 'bf_test_secret');
  vi.stubEnv('BALANCEFRAME_SESSION_COOKIE', '');
  vi.stubEnv('BALANCEFRAME_ACTOR_ID', 'usr_env_attacker');
  vi.stubEnv('ACTUAL_SERVER_URL', 'http://127.0.0.1:1');
  vi.stubEnv('ACTUAL_SECRET_KEY', 'actual_test_secret');
  vi.stubEnv('ACTUAL_BUDGET_PASSWORD', 'actual_budget_secret');
  vi.stubEnv('BALANCEFRAME_CONFIG_PATH', join(isolatedDirectory, 'connection.json'));
  vi.stubEnv('BALANCEFRAME_WORKFLOW_DB_PATH', join(isolatedDirectory, 'workflow.sqlite'));
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      const request = input instanceof Request ? input : undefined;
      const headers = new Headers(request?.headers);
      new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
      requests.push({
        url: new URL(request?.url ?? String(input)),
        method: request?.method ?? String(init?.method ?? 'GET'),
        headers,
        body: typeof init?.body === 'string' ? init.body : undefined,
      });
      return typeof response === 'function' ? response() : response;
    }),
  );
  return requests;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(isolatedDirectory, { recursive: true, force: true });
});

describe('production CLI governance transport', () => {
  it('refuses unauthenticated reads and approvals instead of falling back to local Actual credentials or actor labels', async () => {
    const requests = setup();
    vi.stubEnv('BALANCEFRAME_API_KEY', '');
    vi.stubEnv('BALANCEFRAME_SESSION_COOKIE', '');

    for (const args of [
      ['transactions', 'pending-review', '--json'],
      ['proposals', 'approve', 'prop_1', '--payload-hash', 'displayed-hash', '--json'],
    ]) {
      const output = JSON.parse(await main(args));
      expect(output.status).toBe('error');
      expect(output.result).toBeNull();
      expect(JSON.stringify(output)).not.toContain('actual_test_secret');
      expect(JSON.stringify(output)).not.toContain('usr_env_attacker');
    }
    expect(requests).toHaveLength(0);
  });

  it('dispatches a real CLI read through the selected space with the verified credential, not the local actor label', async () => {
    const requests = setup();
    const output = JSON.parse(await main(['transactions', 'pending-review', '--json']));

    expect(output.status).toBe('ok');
    expect(output.authorization.actorId).toBe('usr_server_principal');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url.pathname).toBe('/api/review');
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer bf_test_secret');
    expect(requests[0]!.headers.get('x-balanceframe-space')).toBe('spc_selected');
    expect(requests[0]!.headers.has('x-balanceframe-actor')).toBe(false);
    expect(requests[0]!.body).toBeUndefined();
    expect(JSON.stringify(requests[0])).not.toContain('usr_env_attacker');
  });

  it('requires a displayed proposal hash and uses the reauthenticated human cookie for approval', async () => {
    const requests = setup(
      () => new Response(JSON.stringify(errorEnvelope('REAUTHENTICATION_REQUIRED')), { status: 403 }),
    );
    const hash = 'a'.repeat(64);
    const missingHash = JSON.parse(await main(['proposals', 'approve', 'prop_1', '--json']));
    expect(missingHash.status).toBe('error');
    expect(requests).toHaveLength(0);

    const apiKeyOnly = JSON.parse(
      await main(['proposals', 'approve', 'prop_1', '--payload-hash', hash, '--json']),
    );
    expect(apiKeyOnly.status).toBe('error');
    expect(requests).toHaveLength(0);

    vi.stubEnv('BALANCEFRAME_SESSION_COOKIE', 'balanceframe_session=session-secret; balanceframe_reauth=server-proof');
    const output = JSON.parse(
      await main(['proposals', 'approve', 'prop_1', '--payload-hash', hash, '--json']),
    );
    expect(output.status).toBe('error');
    expect(output.error.code).toBe('REAUTHENTICATION_REQUIRED');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url.pathname).toBe('/api/proposal/prop_1/approve');
    expect(requests[0]!.headers.get('cookie')).toBe(
      'balanceframe_session=session-secret; balanceframe_reauth=server-proof',
    );
    expect(requests[0]!.headers.has('authorization')).toBe(false);
    expect(JSON.parse(requests[0]!.body ?? '{}')).toEqual({ payloadHash: hash });
    expect(JSON.stringify(requests[0])).not.toContain('usr_env_attacker');
    expect(output.error.message).not.toContain('session-secret');
    expect(output.error.message).not.toContain('server-proof');
  });

  it('requires unique review IDs and an exact non-empty hash map before bulk approval', async () => {
    const hashMap = JSON.stringify({ rev_a: 'opaque-a', rev_b: 'opaque-b' });
    const valid = parseArgs([
      'reviews',
      'approve-bulk',
      'rev_a',
      'rev_b',
      '--payload-hashes',
      hashMap,
      '--json',
    ]);
    expect(valid.ok).toBe(true);

    for (const args of [
      ['reviews', 'approve-bulk', 'rev_a', '--json'],
      ['reviews', 'approve-bulk', 'rev_a', '--payload-hashes', '{"rev_other":"opaque"}', '--json'],
      ['reviews', 'approve-bulk', 'rev_a', '--payload-hashes', '{"rev_a":""}', '--json'],
      ['reviews', 'approve-bulk', 'rev_a', 'rev_a', '--payload-hashes', '{"rev_a":"opaque"}', '--json'],
      ['reviews', 'approve-bulk', 'rev_a', '--payload-hashes', '[]', '--json'],
    ]) {
      expect(parseArgs(args).ok).toBe(false);
    }

    const requests = setup();
    vi.stubEnv('BALANCEFRAME_SESSION_COOKIE', 'balanceframe_session=session-secret; balanceframe_reauth=server-proof');
    const result = JSON.parse(
      await main([
        'reviews',
        'approve-bulk',
        'rev_a',
        'rev_b',
        '--payload-hashes',
        hashMap,
        '--json',
      ]),
    );
    expect(result.status).toBe('ok');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url.pathname).toBe('/api/review/approve-bulk');
    expect(requests[0]!.headers.get('cookie')).toBe(
      'balanceframe_session=session-secret; balanceframe_reauth=server-proof',
    );
    expect(requests[0]!.headers.has('authorization')).toBe(false);
    expect(JSON.parse(requests[0]!.body ?? '{}')).toEqual({
      ids: ['rev_a', 'rev_b'],
      payloadHashes: { rev_a: 'opaque-a', rev_b: 'opaque-b' },
    });
  });

  it('sends operational proposal execution to the server for exact delegation enforcement', async () => {
    const requests = setup(
      () => new Response(JSON.stringify(errorEnvelope('AUTHORIZATION_DENIED')), { status: 403 }),
    );
    const output = JSON.parse(await main(['proposals', 'execute', 'prop_1', '--json']));

    expect(output.status).toBe('error');
    expect(output.error.code).toBe('AUTHORIZATION_DENIED');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url.pathname).toBe('/api/proposal/prop_1/execute');
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer bf_test_secret');
    expect(requests[0]!.headers.get('x-balanceframe-space')).toBe('spc_selected');
    expect(requests[0]!.body).toBeUndefined();
    expect(JSON.stringify(requests[0])).not.toContain('usr_env_attacker');
  });

  it('sends selected-space control mutations with the human cookie instead of an API key', async () => {
    const requests = setup();
    vi.stubEnv('BALANCEFRAME_SESSION_COOKIE', 'balanceframe_session=session-secret; balanceframe_reauth=server-proof');
    const result = JSON.parse(
      await main([
        'spaces',
        'policy',
        'set',
        '--expected-version',
        'policy-v3',
        '--policy',
        '{"minimumApprovers":2}',
        '--json',
      ]),
    );

    expect(result.status).toBe('ok');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url.pathname).toBe('/api/spaces/spc_selected/policy');
    expect(requests[0]!.headers.get('x-balanceframe-space')).toBe('spc_selected');
    expect(requests[0]!.headers.get('cookie')).toBe(
      'balanceframe_session=session-secret; balanceframe_reauth=server-proof',
    );
    expect(requests[0]!.headers.has('authorization')).toBe(false);
  });
  it('uses a server-issued human session cookie without forwarding passwords or actor labels', async () => {
    const requests = setup(
      () =>
        new Response(JSON.stringify(errorEnvelope('REAUTHENTICATION_REQUIRED')), { status: 403 }),
    );
    vi.stubEnv('BALANCEFRAME_API_KEY', '');
    vi.stubEnv(
      'BALANCEFRAME_SESSION_COOKIE',
      'balanceframe_session=session-secret; balanceframe_reauth=server-proof',
    );
    const result = await main([
      'spaces',
      'policy',
      'set',
      '--expected-version',
      'policy-v3',
      '--policy',
      '{"minimumApprovers":2}',
      '--json',
    ]);

    expect(JSON.parse(result).error.code).toBe('REAUTHENTICATION_REQUIRED');
    expect(result).not.toContain('session-secret');
    expect(result).not.toContain('server-proof');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.get('cookie')).toBe(
      'balanceframe_session=session-secret; balanceframe_reauth=server-proof',
    );
    expect(requests[0]!.headers.has('authorization')).toBe(false);
    expect(requests[0]!.body).not.toContain('actorId');
    expect(requests[0]!.body).not.toContain('password');
  });

  it('does not turn invalid JSON, malformed envelopes, or success bodies with error statuses into success', async () => {
    const replies = [
      new Response('not-json', { status: 200 }),
      new Response(JSON.stringify({ status: 'ok', result: { items: [] } }), { status: 200 }),
      new Response(JSON.stringify(okEnvelope({ items: [], total: 0 })), { status: 403 }),
    ];
    for (const reply of replies) {
      setup(reply);
      const output = JSON.parse(await main(['transactions', 'pending-review', '--json']));
      expect(output.status).toBe('error');
      expect(output.result).toBeNull();
    }
  });

  it('requires an explicit selected space before a scoped production read', async () => {
    const requests = setup();
    vi.stubEnv('BALANCEFRAME_SPACE_ID', '');
    const output = JSON.parse(await main(['transactions', 'pending-review', '--json']));

    expect(output.status).toBe('error');
    expect(output.error.code).toBe('space_selection_required');
    expect(requests).toHaveLength(0);
  });
  it('uses a cookie-selected space only when no explicit space is configured', async () => {
    const requests = setup();
    vi.stubEnv('BALANCEFRAME_SPACE_ID', '');
    vi.stubEnv('BALANCEFRAME_SESSION_COOKIE', 'balanceframe_session=session-secret; balanceframe_space=spc_cookie');

    const result = JSON.parse(await main(['spaces', 'show', '--json']));

    expect(result.status).toBe('ok');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url.pathname).toBe('/api/spaces/spc_cookie');
    expect(requests[0]!.headers.get('x-balanceframe-space')).toBe('spc_cookie');
  });

  it('does not let a cookie replace an explicitly configured selected space', async () => {
    const requests = setup(() => new Response(JSON.stringify(errorEnvelope('FORBIDDEN')), { status: 403 }));
    vi.stubEnv('BALANCEFRAME_SPACE_ID', 'spc_configured');
    vi.stubEnv('BALANCEFRAME_SESSION_COOKIE', 'balanceframe_session=session-secret; balanceframe_space=spc_cookie');

    await main(['spaces', 'show', '--json']);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url.pathname).toBe('/api/spaces/spc_configured');
    expect(requests[0]!.headers.get('x-balanceframe-space')).toBe('spc_configured');
  });

  it('preserves server errors without exposing configured credentials', async () => {
    const serverError = errorEnvelope('SPACE_MEMBERSHIP_REQUIRED');
    serverError.error.message = 'Rejected credential bf_test_secret.';
    const requests = setup(
      () => new Response(JSON.stringify(serverError), { status: 403 }),
    );
    const result = await main(['transactions', 'pending-review', '--json']);
    const output = JSON.parse(result);

    expect(output.status).toBe('error');
    expect(output.error.code).toBe('SPACE_MEMBERSHIP_REQUIRED');
    expect(result).not.toContain('bf_test_secret');
    expect(output.error.message).toContain('[redacted]');
    expect(requests).toHaveLength(1);
  });

  it('keeps caller actor IDs as audit filters and rejects them on approval commands', async () => {
    const requests = setup();
    const output = JSON.parse(
      await main([
        'audit',
        'query',
        '--actor-id',
        'usr_filter',
        '--entity-id',
        'entity_filter',
        '--json',
      ]),
    );
    expect(output.status).toBe('ok');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url.pathname).toBe('/api/spaces/spc_selected/audit');
    expect(requests[0]!.url.searchParams.get('entityId')).toBe('entity_filter');
    expect(requests[0]!.headers.get('x-balanceframe-space')).toBe('spc_selected');
    expect(requests[0]!.headers.has('x-balanceframe-actor')).toBe(false);
    expect(requests[0]!.body).toBeUndefined();

    const impersonation = JSON.parse(
      await main([
        'proposals',
        'approve',
        'prop_1',
        '--payload-hash',
        'shown-hash',
        '--actor-id',
        'usr_impersonated',
        '--json',
      ]),
    );
    expect(impersonation.status).toBe('error');
    expect(impersonation.error.code).toBe('actor_filter_only');
    expect(requests).toHaveLength(1);
  });

  it('uses explicit selected-space endpoints for governance control-plane commands', async () => {
    const requests = setup(() => new Response(JSON.stringify(okEnvelope({ spaceId: 'spc_new' }))));
    vi.stubEnv('BALANCEFRAME_SESSION_COOKIE', 'balanceframe_session=session-secret; balanceframe_reauth=server-proof');
    const created = JSON.parse(
      await main(['spaces', 'create', '--name', 'Family ledger', '--kind', 'shared', '--json']),
    );
    const selected = JSON.parse(await main(['spaces', 'select', 'spc_new', '--json']));

    expect(created.status).toBe('ok');
    expect(selected.status).toBe('ok');
    expect(requests).toHaveLength(2);
    expect(requests[0]!.url.pathname).toBe('/api/spaces');
    expect(requests[0]!.headers.get('cookie')).toBe(
      'balanceframe_session=session-secret; balanceframe_reauth=server-proof',
    );
    expect(requests[0]!.headers.has('authorization')).toBe(false);
    expect(requests[0]!.headers.has('x-balanceframe-space')).toBe(false);
    expect(JSON.parse(requests[0]!.body ?? '{}')).toEqual({
      name: 'Family ledger',
      kind: 'shared',
    });
    expect(requests[1]!.url.pathname).toBe('/api/spaces/spc_new/select');
    expect(requests[1]!.headers.get('x-balanceframe-space')).toBe('spc_new');
    expect(requests[1]!.headers.get('cookie')).toBe(
      'balanceframe_session=session-secret; balanceframe_reauth=server-proof',
    );
    expect(requests[1]!.headers.has('authorization')).toBe(false);
    expect(JSON.parse(requests[1]!.body ?? '{}')).toEqual({});
  });
  it('sends governance policy updates with the exact expected version and parsed policy', async () => {
    const requests = setup();
    vi.stubEnv('BALANCEFRAME_SESSION_COOKIE', 'balanceframe_session=session-secret; balanceframe_reauth=server-proof');
    const output = JSON.parse(
      await main([
        'spaces',
        'policy',
        'set',
        '--expected-version',
        'policy-v3',
        '--policy',
        '{"minimumApprovers":2}',
        '--json',
      ]),
    );

    expect(output.status).toBe('ok');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url.pathname).toBe('/api/spaces/spc_selected/policy');
    expect(requests[0]!.headers.get('x-balanceframe-space')).toBe('spc_selected');
    expect(requests[0]!.headers.get('cookie')).toBe(
      'balanceframe_session=session-secret; balanceframe_reauth=server-proof',
    );
    expect(requests[0]!.headers.has('authorization')).toBe(false);
    expect(JSON.parse(requests[0]!.body ?? '{}')).toEqual({
      expectedVersion: 'policy-v3',
      policy: { minimumApprovers: 2 },
    });
  });

  it('maps temporal membership, grant, delegation, agent, and credential commands to their real space routes', async () => {
    const requests = setup(
      () => new Response(JSON.stringify(okEnvelope({ result: 'server-owned' }))),
    );
    vi.stubEnv('BALANCEFRAME_SESSION_COOKIE', 'balanceframe_session=session-secret; balanceframe_reauth=server-proof');
    const cases: Array<{
      args: string[];
      method: string;
      path: string;
      body?: unknown;
      humanControl?: boolean;
    }> = [
      {
        args: ['spaces', 'members', 'history'],
        method: 'GET',
        path: '/api/spaces/spc_selected/memberships',
      },
      {
        args: [
          'spaces',
          'members',
          'add',
          '--member-id',
          'usr_added',
          '--valid-from',
          '2026-10-01T00:00:00Z',
        ],
        method: 'POST',
        path: '/api/spaces/spc_selected/memberships',
        body: { actorId: 'usr_added', validFrom: '2026-10-01T00:00:00Z' },
        humanControl: true,
      },
      { args: ['spaces', 'memberships', 'list'], method: 'GET', path: '/api/spaces/spc_selected/memberships' },
      {
        args: [
          'spaces',
          'memberships',
          'create',
          '--member-id',
          'usr_member',
          '--valid-from',
          '2026-10-01T00:00:00Z',
          '--valid-until',
          '2026-12-01T00:00:00Z',
        ],
        method: 'POST',
        path: '/api/spaces/spc_selected/memberships',
        body: {
          actorId: 'usr_member',
          validFrom: '2026-10-01T00:00:00Z',
          validUntil: '2026-12-01T00:00:00Z',
        },
        humanControl: true,
      },
      {
        args: ['spaces', 'memberships', 'revoke', 'mem_1'],
        method: 'POST',
        path: '/api/spaces/spc_selected/memberships/mem_1/revoke',
        body: {},
        humanControl: true,
      },
      { args: ['spaces', 'grants', 'list'], method: 'GET', path: '/api/spaces/spc_selected/grants' },
      {
        args: [
          'spaces',
          'grants',
          'set',
          '--membership-id',
          'mem_1',
          '--capability',
          'transaction:view',
          '--resource-kind',
          'account',
          '--resource-id',
          'acc_1',
          '--granted',
          'true',
          '--restrictions',
          '{"aggregateOnly":true}',
        ],
        method: 'PUT',
        path: '/api/spaces/spc_selected/grants',
        body: {
          membershipId: 'mem_1',
          capability: 'transaction:view',
          resourceKind: 'account',
          resourceId: 'acc_1',
          granted: true,
          restrictions: { aggregateOnly: true },
        },
        humanControl: true,
      },
      {
        args: [
          'spaces',
          'grants',
          'revoke',
          '--membership-id',
          'mem_1',
          '--capability',
          'transaction:view',
          '--resource-kind',
          'account',
          '--resource-id',
          'acc_1',
        ],
        method: 'PUT',
        path: '/api/spaces/spc_selected/grants',
        body: {
          membershipId: 'mem_1',
          capability: 'transaction:view',
          resourceKind: 'account',
          resourceId: 'acc_1',
          granted: false,
        },
        humanControl: true,
      },
      { args: ['spaces', 'delegations', 'list'], method: 'GET', path: '/api/spaces/spc_selected/delegations' },
      {
        args: [
          'spaces',
          'delegations',
          'create',
          '--agent-id',
          'agt_1',
          '--issuer-membership-id',
          'mem_1',
          '--expected-version',
          'null',
          '--rights',
          '{"proposalOnly":true}',
          '--valid-from',
          '2026-10-01T00:00:00Z',
        ],
        method: 'POST',
        path: '/api/spaces/spc_selected/delegations',
        body: {
          agentId: 'agt_1',
          issuerMembershipId: 'mem_1',
          expectedVersion: null,
          rights: { proposalOnly: true },
          validFrom: '2026-10-01T00:00:00Z',
        },
        humanControl: true,
      },
      {
        args: ['spaces', 'delegations', 'revoke', 'del_1', '--expected-version', 'delegate-v2'],
        method: 'POST',
        path: '/api/spaces/spc_selected/delegations/del_1/revoke',
        body: { expectedVersion: 'delegate-v2' },
        humanControl: true,
      },
      {
        args: ['spaces', 'agents', 'register', '--agent-id', 'agt_1'],
        method: 'POST',
        path: '/api/spaces/spc_selected/agents',
        body: { agentId: 'agt_1' },
        humanControl: true,
      },
      { args: ['spaces', 'credentials', 'list'], method: 'GET', path: '/api/spaces/spc_selected/credentials' },
      {
        args: [
          'spaces',
          'credentials',
          'register',
          '--credential-id',
          'cred_1',
          '--principal-type',
          'agent',
          '--principal-id',
          'agt_1',
          '--delegation-id',
          'del_1',
          '--expected-delegation-version',
          'delegate-v2',
        ],
        method: 'POST',
        path: '/api/spaces/spc_selected/credentials',
        body: {
          credentialId: 'cred_1',
          principalType: 'agent',
          principalId: 'agt_1',
          delegationId: 'del_1',
          expectedDelegationVersion: 'delegate-v2',
        },
        humanControl: true,
      },
      {
        args: ['spaces', 'credentials', 'revoke', 'cred_1'],
        method: 'POST',
        path: '/api/spaces/spc_selected/credentials/cred_1/revoke',
        body: {},
        humanControl: true,
      },
    ];

    for (const item of cases) {
      const output = JSON.parse(await main([...item.args, '--json']));
      expect(output).toMatchObject({ status: 'ok' });
    }
    expect(requests).toHaveLength(cases.length);
    cases.forEach((item, index) => {
      const request = requests[index]!;
      expect(request.method).toBe(item.method);
      expect(request.url.pathname).toBe(item.path);
      expect(request.headers.get('x-balanceframe-space')).toBe('spc_selected');
      if (item.body !== undefined) expect(JSON.parse(request.body ?? '{}')).toEqual(item.body);
      else expect(request.body).toBeUndefined();
      expect(request.headers.get('cookie')).toBe(
        item.humanControl ? 'balanceframe_session=session-secret; balanceframe_reauth=server-proof' : null,
      );
      expect(request.headers.has('authorization')).toBe(!item.humanControl);
    });
  });
  it('never enters local ledger or actor-injection handlers when an options object is supplied', async () => {
    const requests = setup();
    const localInjection = {
      actorId: 'usr_impersonated',
      requestId: 'local-request',
      mode: 'managedAutomation',
      ledger: { privateLedger: true },
      analysisProtocol: {
        async pendingReview() {
          return {
            nativeRuleBlocks: [],
            nativeRuleParts: [],
            nativeRuleSets: [],
            uncategorizedCount: 99,
            totalUncategorizedAmount: { minorUnits: '99900', currency: 'USD' },
            candidates: [],
            oldestUncategorizedDate: null,
            healthState: 'unknown',
            blockers: [],
          };
        },
      },
    };
    const callMainWithUntrustedRuntimeOptions = main as unknown as (
      args: string[],
      options: unknown,
    ) => Promise<string>;

    const result = JSON.parse(
      await callMainWithUntrustedRuntimeOptions(
        ['transactions', 'pending-review', '--json'],
        localInjection,
      ),
    );

    expect(result.status).toBe('ok');
    expect(result.authorization.actorId).toBe('usr_server_principal');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url.pathname).toBe('/api/review');
    expect(JSON.stringify(result)).not.toContain('usr_impersonated');
    expect(JSON.stringify(result)).not.toContain('99900');
    expect(JSON.stringify(requests[0])).not.toContain('usr_impersonated');
  });
  it('routes connection and lifecycle custody operations through fresh human server auth', async () => {
    const requests = setup();
    vi.stubEnv('BALANCEFRAME_SESSION_COOKIE', 'balanceframe_session=session-secret; balanceframe_reauth=server-proof');
    const cases: Array<{ args: string[]; method: string; path: string; body?: unknown }> = [
      { args: ['budget', 'list'], method: 'GET', path: '/api/connection/budgets' },
      { args: ['connect', '--budget-id', 'bud_1'], method: 'POST', path: '/api/connection', body: { budgetId: 'bud_1' } },
      { args: ['export'], method: 'POST', path: '/api/lifecycle/export' },
      { args: ['disconnect'], method: 'POST', path: '/api/lifecycle/disconnect' },
      { args: ['remove-connection'], method: 'POST', path: '/api/lifecycle/remove-connection' },
      { args: ['delete-data', '--scope', 'connection'], method: 'POST', path: '/api/lifecycle/delete-data', body: { scope: 'connection' } },
    ];

    for (const item of cases) {
      expect(JSON.parse(await main([...item.args, '--json']))).toMatchObject({ status: 'ok' });
    }
    expect(requests).toHaveLength(cases.length);
    cases.forEach((item, index) => {
      const request = requests[index]!;
      expect(request.method).toBe(item.method);
      expect(request.url.pathname).toBe(item.path);
      expect(request.headers.get('x-balanceframe-space')).toBe('spc_selected');
      expect(request.headers.get('cookie')).toBe(
        'balanceframe_session=session-secret; balanceframe_reauth=server-proof',
      );
      expect(request.headers.has('authorization')).toBe(false);
      if (item.body !== undefined) expect(JSON.parse(request.body ?? '{}')).toEqual(item.body);
      else expect(request.body).toBeUndefined();
    });
  });

  it('maps financial commands to server APIs without caller actor identities', async () => {
    const requests = setup();
    vi.stubEnv('BALANCEFRAME_SESSION_COOKIE', 'balanceframe_session=session-secret; balanceframe_reauth=server-proof');
    const cases: Array<{
      args: string[];
      method: string;
      path: string;
      body?: unknown;
      query?: Record<string, string>;
      humanControl?: boolean;
    }> = [
      { args: ['transactions', 'pending-review'], method: 'GET', path: '/api/review' },
      { args: ['reviews', 'show', 'rev_1'], method: 'GET', path: '/api/review/rev_1' },
      { args: ['reviews', 'correct', 'rev_1', 'cat_1'], method: 'POST', path: '/api/review/correct', body: { reviewId: 'rev_1', categoryId: 'cat_1' } },
      { args: ['reviews', 'reject', 'rev_1'], method: 'POST', path: '/api/review/reject', body: { reviewId: 'rev_1' } },
      { args: ['reviews', 'skip', 'rev_1'], method: 'POST', path: '/api/review/skip', body: { reviewId: 'rev_1' } },
      { args: ['reviews', 'undo', 'rev_1'], method: 'POST', path: '/api/review/undo', body: { reviewId: 'rev_1' } },
      { args: ['reviews', 'group', 'rev_1', 'rev_2'], method: 'POST', path: '/api/review/group', body: { ids: ['rev_1', 'rev_2'] } },
      { args: ['budget', 'summary'], method: 'GET', path: '/api/home/budget-summary' },
      { args: ['proposals', 'create', '--category-id', 'cat_1', '--message', 'Review'], method: 'POST', path: '/api/proposal', body: { categoryId: 'cat_1', message: 'Review' } },
      { args: ['proposals', 'show', 'prop_1'], method: 'GET', path: '/api/proposal/prop_1' },
      { args: ['proposals', 'approve', 'prop_1', '--payload-hash', 'a'.repeat(64)], method: 'POST', path: '/api/proposal/prop_1/approve', body: { payloadHash: 'a'.repeat(64) }, humanControl: true },
      { args: ['proposals', 'execute', 'prop_1'], method: 'POST', path: '/api/proposal/prop_1/execute' },
      { args: ['proposals', 'list'], method: 'GET', path: '/api/proposal' },
      { args: ['audit', 'query', '--actor-id', 'usr_filter', '--from', '2026-09-01', '--limit', '10'], method: 'GET', path: '/api/spaces/spc_selected/audit', query: { actorId: 'usr_filter', from: '2026-09-01', limit: '10' } },
      { args: ['rules', 'create', '--name', 'Auto', '--payee-id', 'payee-Market', '--category-id', 'category-food'], method: 'POST', path: '/api/rule', body: { name: 'Auto', payeeId: 'payee-Market', categoryId: 'category-food' } },
      { args: ['rules', 'list'], method: 'GET', path: '/api/rule' },
      { args: ['rules', 'show', '--rule-id', 'rule_1'], method: 'GET', path: '/api/rule/rule_1' },
      { args: ['purchase', 'evaluate', '--category-id', 'cat_1', '--amount', '500'], method: 'GET', path: '/api/purchase/evaluate', query: { categoryId: 'cat_1', amount: '500', currency: 'USD' } },
      { args: ['cash-flow', 'project', '--months', '6', '--start-month', '2026-10'], method: 'GET', path: '/api/cash-flow/project', query: { months: '6', startMonth: '2026-10' } },
      { args: ['target', 'health'], method: 'GET', path: '/api/targets/health' },
      { args: ['sinking-fund', 'health'], method: 'GET', path: '/api/sinking-fund/health' },
      { args: ['reports', 'generate', '--report-type', 'monthly', '--month-range', '2026-09'], method: 'GET', path: '/api/reports/generate', query: { reportType: 'monthly', monthRange: '2026-09' } },
      { args: ['views', 'list'], method: 'GET', path: '/api/reports/views' },
      { args: ['views', 'create', '--name', 'Household', '--view-type', 'budget', '--scope', '{"owner":"user"}'], method: 'POST', path: '/api/reports/views', body: { name: 'Household', viewType: 'budget', scope: { owner: 'user' } } },
      { args: ['home', 'attention', '--detailed', '--category-group', 'food'], method: 'GET', path: '/api/home/attention', query: { detailed: 'true', categoryGroup: 'food' } },
    ];

    for (const item of cases) {
      expect(JSON.parse(await main([...item.args, '--json']))).toMatchObject({ status: 'ok' });
    }
    expect(requests).toHaveLength(cases.length);
    cases.forEach((item, index) => {
      const request = requests[index]!;
      expect(request.method).toBe(item.method);
      expect(request.url.pathname).toBe(item.path);
      expect(request.headers.get('x-balanceframe-space')).toBe('spc_selected');
      expect(request.headers.get('cookie')).toBe(
        item.humanControl ? 'balanceframe_session=session-secret; balanceframe_reauth=server-proof' : null,
      );
      expect(request.headers.get('authorization')).toBe(item.humanControl ? null : 'Bearer bf_test_secret');
      if (item.body !== undefined) expect(JSON.parse(request.body ?? '{}')).toEqual(item.body);
      else expect(request.body).toBeUndefined();
      for (const [key, value] of Object.entries(item.query ?? {})) {
        expect(request.url.searchParams.get(key)).toBe(value);
      }
      expect(JSON.stringify(request)).not.toContain('usr_env_attacker');
    });
  });
});

describe('merchant command transport', () => {
  it('dispatches paginated merchant evidence without converting exact Money', async () => {
    const money = { minorUnits: '9223372036854775807', currency: 'KWD' };
    const requests = setup(() => new Response(JSON.stringify(okEnvelope({ money }))));
    const output = JSON.parse(await main(['merchant', 'evidence', '--transaction-id', 'tx-child', '--limit', '1', '--facts-hash', 'current', '--json']));
    expect(output.result.money).toEqual(money);
    expect(requests[0]!.url.pathname).toBe('/api/merchant');
    expect(requests[0]!.url.searchParams.get('transactionId')).toBe('tx-child');
    expect(requests[0]!.url.searchParams.get('limit')).toBe('1');
    expect(requests[0]!.headers.get('x-balanceframe-space')).toBe('spc_selected');
  });
  it('requires human cookies and sends only explicit optimistic alias control fields', async () => {
    const requests = setup();
    const args = ['merchant', 'confirm', '--id', 'alias-1', '--kind', 'alias', '--evidence-key', 'merchant:transaction:tx', '--evidence-revision', 'rev', '--expected-version', '0', '--private', '--transaction-id', 'tx', '--source-field', 'importedPayee', '--target-payee-id', 'payee-ID', '--account-id', 'account-ID', '--json'];
    expect(JSON.parse(await main(args)).error.code).toBe('human_session_required');
    expect(requests).toHaveLength(0);
    vi.stubEnv('BALANCEFRAME_SESSION_COOKIE', 'balanceframe_session=human; balanceframe_reauth=proof');
    expect(JSON.parse(await main(args)).status).toBe('ok');
    expect(JSON.parse(requests[0]!.body!)).toEqual({ id: 'alias-1', kind: 'alias', evidenceKey: 'merchant:transaction:tx', evidenceRevision: 'rev', expectedVersion: 0, visibility: 'private', transactionId: 'tx', sourceField: 'importedPayee', targetPayeeId: 'payee-ID', accountId: 'account-ID' });
    expect(requests[0]!.headers.has('authorization')).toBe(false);
  });
  it('keeps explicit global alias selection distinct from global authority', async () => {
    const requests = setup(() => new Response(JSON.stringify(errorEnvelope('FORBIDDEN')), { status: 403 }));
    vi.stubEnv('BALANCEFRAME_SESSION_COOKIE', 'balanceframe_session=human; balanceframe_reauth=proof');
    const result = JSON.parse(await main(['merchant', 'confirm', '--id', 'global-alias', '--kind', 'alias', '--evidence-key', 'merchant:transaction:tx', '--evidence-revision', 'current', '--expected-version', '0', '--shared', '--transaction-id', 'tx', '--source-field', 'payeeName', '--target-payee-id', 'PAYEE-ID', '--account-id', 'null', '--json']));
    expect(result.status).toBe('error');
    expect(result.error.code).toBe('FORBIDDEN');
    expect(JSON.parse(requests[0]!.body!)).toMatchObject({ accountId: null, visibility: 'shared', targetPayeeId: 'PAYEE-ID' });
    expect(JSON.parse(requests[0]!.body!)).not.toHaveProperty('verifiedHuman');
  });
  it('rejects a shared pattern using current optimistic evidence without alias or actor authority', async () => {
    const requests = setup();
    vi.stubEnv('BALANCEFRAME_SESSION_COOKIE', 'balanceframe_session=human; balanceframe_reauth=proof');
    const output = JSON.parse(await main(['merchant', 'reject', '--id', 'pattern-decision', '--kind', 'pattern', '--pattern-id', 'pattern-ID', '--evidence-key', 'merchant:pattern:pattern-ID', '--evidence-revision', 'current', '--expected-version', '2', '--shared', '--json']));
    expect(output.status).toBe('ok');
    expect(requests[0]!.url.pathname).toBe('/api/merchant/reject');
    expect(JSON.parse(requests[0]!.body!)).toEqual({ id: 'pattern-decision', kind: 'pattern', patternId: 'pattern-ID', evidenceKey: 'merchant:pattern:pattern-ID', evidenceRevision: 'current', expectedVersion: 2, visibility: 'shared' });
  });
  it('dispatches policy/calendar/export/delete through separate governed server endpoints', async () => {
    const requests = setup();
    vi.stubEnv('BALANCEFRAME_SESSION_COOKIE', 'balanceframe_session=human; balanceframe_reauth=proof');
    for (const args of [
      ['merchant', 'policy', 'get'],
      ['merchant', 'policy', 'set', '--expected-version', '3', '--policy', '{"mode":"local-only"}'],
      ['merchant', 'calendar', '--account-id', 'account', '--year', '2026'],
      ['merchant', 'export'], ['merchant', 'delete'],
    ]) expect(JSON.parse(await main([...args, '--json'])).status).toBe('ok');
    expect(requests.map((r) => [r.method, r.url.pathname])).toEqual([['GET', '/api/merchant/policy'], ['PUT', '/api/merchant/policy'], ['GET', '/api/merchant/calendar'], ['GET', '/api/merchant/export'], ['DELETE', '/api/merchant']]);
    expect(JSON.parse(requests[1]!.body!)).toEqual({ expectedVersion: 3, value: { mode: 'local-only' } });
    expect(requests[2]!.url.searchParams.get('year')).toBe('2026');
  });
  it.each(['--actor-id', '--auth', '--source-refs', '--verified-human', '--jurisdiction'])('rejects authority/lookup override flag %s', (flag) => {
    expect(parseArgs(['merchant', 'analyze', flag, 'forged', '--json']).ok).toBe(false);
  });
  it('rejects ambiguous visibility and unsafe optimistic integer controls', () => {
    expect(parseArgs(['merchant', 'confirm', '--private', '--shared']).ok).toBe(false);
    expect(parseArgs(['merchant', 'policy', 'set', '--expected-version', '9007199254740993', '--policy', '{}']).ok).toBe(false);
  });
});

describe('separate consented public-business research transport', () => {
  const revision = 'a'.repeat(64);
  const queryArgs = ['--evidence-key', 'merchant:transaction:tx-leaf', '--evidence-revision', revision, '--merchant', 'Northstar Public Bakery', '--public-business', 'true'];
  const query = { evidenceKey: 'merchant:transaction:tx-leaf', evidenceRevision: revision, merchant: 'Northstar Public Bakery', locale: null, publicBusiness: true };
  const preview = {
    status: 'ready', previewToken: 'b'.repeat(64), ...query, providerId: 'valueserp', providerVersion: 'valueserp-search/1',
    expiresAt: '2026-10-04T12:05:00.000Z', fieldsSent: ['merchant', 'locale'],
    disclosure: 'Separate public search; provider sees text and server IP. Retention unknown. Sent requests cannot be recalled.',
    maxCostAtoms: '9007199254740993000001', billingCurrency: 'USD',
  };
  // Preview responses disclose the query, not the client's declaration field.
  const ready = () => { const { publicBusiness: _declaration, ...result } = preview; return result; };

  it('prints the exact preview disclosure and atom cost without dispatching research or reading bank text', async () => {
    const requests = setup(() => new Response(JSON.stringify(okEnvelope(ready()))));
    const output = JSON.parse(await main(['merchant', 'research', 'preview', ...queryArgs, '--json']));
    expect(output.status).toBe('ok');
    expect(output.result).toEqual(ready());
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url.pathname).toBe('/api/merchant/research/preview');
    expect(requests[0]!.url.search).toBe('');
    expect(requests[0]!.method).toBe('POST');
    expect(JSON.parse(requests[0]!.body!)).toEqual(query);
    expect(requests[0]!.headers.get('origin')).toBe('https://balanceframe.example');
    expect(requests[0]!.headers.get('x-balanceframe-space')).toBe('spc_selected');
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer bf_test_secret');
  });

  it('requires a separately supplied matching preview token, explicit consent and idempotency key before send', async () => {
    const requests = setup(() => new Response(JSON.stringify(okEnvelope({ status: 'pending', attemptId: 'attempt-one' }))));
    for (const extra of [
      [], ['--preview-token', preview.previewToken], ['--preview-token', preview.previewToken, '--consent', 'false', '--idempotency-key', 'request-1'],
      ['--preview-token', preview.previewToken, '--consent', 'true'],
    ]) expect(JSON.parse(await main(['merchant', 'research', 'send', ...queryArgs, ...extra, '--json'])).status).toBe('error');
    expect(requests).toHaveLength(0);
    const output = JSON.parse(await main(['merchant', 'research', 'send', ...queryArgs, '--preview-token', preview.previewToken, '--consent', 'true', '--idempotency-key', 'request-1', '--locale', 'CA', '--json']));
    expect(output.result).toEqual({ status: 'pending', attemptId: 'attempt-one' });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url.pathname).toBe('/api/merchant/research');
    expect(JSON.parse(requests[0]!.body!)).toEqual({ ...query, locale: 'CA', previewToken: preview.previewToken, consent: true, idempotencyKey: 'request-1' });
  });

  it.each(['--actor-id', '--budget-id', '--scope', '--auth', '--provider', '--provider-id', '--api-key', '--tariff', '--endpoint', '--transaction-id', '--notes'])('refuses client authority or bank-text flag %s', async (flag) => {
    const requests = setup();
    const output = JSON.parse(await main(['merchant', 'research', 'preview', ...queryArgs, flag, 'PRIVATE-QUERY', '--json']));
    expect(output.status).toBe('error');
    expect(requests).toHaveLength(0);
    expect(JSON.stringify(output)).not.toContain('PRIVATE-QUERY');
  });

  it('rejects undeclared or absent public text, invalid coarse locale, duplicate flags and preview consent flags', () => {
    for (const args of [
      ['--evidence-key', query.evidenceKey, '--evidence-revision', revision, '--public-business', 'true'],
      [...queryArgs.slice(0, -2)], [...queryArgs.slice(0, -1), 'false'],
      [...queryArgs, '--locale', 'JP'], [...queryArgs, '--merchant', 'duplicate'],
      [...queryArgs, '--preview-token', preview.previewToken], [...queryArgs, '--consent', 'true'],
    ]) expect(parseArgs(['merchant', 'research', 'preview', ...args, '--json']).ok).toBe(false);
  });

  it('reads cache explicitly without consent or an automatic provider request', async () => {
    const requests = setup(() => new Response(JSON.stringify(okEnvelope({ enrichment: null }))));
    const output = JSON.parse(await main(['merchant', 'research', 'cache', ...queryArgs, '--json']));
    expect(output.result).toEqual({ enrichment: null });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url.pathname).toBe('/api/merchant/research/cache');
    expect(JSON.parse(requests[0]!.body!)).toEqual(query);
  });

  it('preserves complete historical uncalibrated source provenance in both succeeded and cached outcomes', async () => {
    const enrichment = {
      key: { scope: { spaceId: 'spc_selected', budgetId: 'budget-selected', connectionId: 'selected-connection' }, queryFingerprint: 'c'.repeat(64), locale: null, providerId: 'valueserp', providerVersion: 'valueserp-search/1', parametersHash: 'd'.repeat(64), normalizationVersion: 'merchant/2', egressPolicyVersion: 'merchant-research/1', visibilityHash: 'e'.repeat(64) },
      sources: [{ url: 'https://public.example.test/business', title: 'Public business', snippet: 'Historical untrusted observation' }],
      fieldsSent: ['merchant', 'locale'], retrievedAt: '2026-10-04T12:00:00.000Z', expiresAt: '2026-10-05T12:00:00.000Z', policyVersion: 1, evidenceRevision: revision, confidence: 'uncalibrated',
      visibility: { hash: 'e'.repeat(64), privateActorId: 'server-principal' },
      sourceRefs: { accountIds: [], categoryIds: [], ruleIds: [], transactionIds: [], factsHash: 'f'.repeat(64), required: [] },
      generation: 1,
    };
    for (const status of ['succeeded', 'cached']) {
      const requests = setup(() => new Response(JSON.stringify(okEnvelope({ status, enrichment }))));
      const output = JSON.parse(await main(['merchant', 'research', 'send', ...queryArgs, '--preview-token', preview.previewToken, '--consent', 'true', '--idempotency-key', 'request-1', '--json']));
      expect(output.result).toEqual({ status, enrichment });
      expect(output.result.enrichment).not.toHaveProperty('categoryId');
      expect(requests).toHaveLength(1);
    }
    const requests = setup(() => new Response(JSON.stringify(okEnvelope({ status: 'succeeded', enrichment: { ...enrichment, confidence: 'confirmed' } }))));
    expect(JSON.parse(await main(['merchant', 'research', 'send', ...queryArgs, '--preview-token', preview.previewToken, '--consent', 'true', '--idempotency-key', 'request-1', '--json'])).error.code).toBe('invalid_server_response');
    expect(requests).toHaveLength(1);
  });

  it('reads independent effective policy versions without editing installation configuration', async () => {
    const value = { mode: 'local-only', allowedProviderIds: [], maxSearchesPerDay: 0, maxSpendMinorUnitsPerMonth: 0, billingCurrency: 'USD', cacheTtlHours: 24 };
    const scope = { spaceId: 'spc_selected', budgetId: 'budget-selected', connectionId: 'selected-connection' };
    const result = {
      installation: { version: 'installation-v5', value },
      space: { scope: { ...scope, connectionId: 'merchant:space-policy' }, version: 3, generation: 3, value },
      budget: { scope, version: 9, generation: 9, value },
      resolved: { mode: 'local-only', allowedProviderIds: [], billingCurrency: 'USD', cacheTtlHours: 24, maxSearchesPerDay: 0, maxSpendMinorUnitsPerMonth: 0, layers: [
        { kind: 'installation', version: 'installation-v5', mode: 'local-only', reason: 'local-only' },
        { kind: 'space', version: '3:3', mode: 'local-only', reason: 'local-only' },
        { kind: 'budget', version: '9:9', mode: 'local-only', reason: 'local-only' },
      ] },
    };
    const requests = setup(() => new Response(JSON.stringify(okEnvelope(result))));
    expect(JSON.parse(await main(['merchant', 'research', 'policy', '--json'])).result).toEqual(result);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url.pathname).toBe('/api/merchant/research/policy');
    expect(requests[0]!.method).toBe('GET');
    expect(requests[0]!.body).toBeUndefined();
  });

  it.each([
    { status: 'failed', code: 'timeout', billing: 'uncertain' },
    { status: 'denied', code: 'stale_source', billing: 'not_dispatched' },
    { status: 'pending', attemptId: 'attempt-existing' },
  ])('returns the exact bounded research outcome without retry: %j', async (result) => {
    const requests = setup(() => new Response(JSON.stringify(okEnvelope(result))));
    const output = JSON.parse(await main(['merchant', 'research', 'send', ...queryArgs, '--preview-token', preview.previewToken, '--consent', 'true', '--idempotency-key', 'request-1', '--json']));
    expect(output.result).toEqual(result);
    expect(requests).toHaveLength(1);
  });

  it.each([
    { ...ready(), maxCostAtoms: 1.25 },
    { ...ready(), apiKey: 'PRIVATE-PROVIDER-KEY' },
    { ...ready(), fieldsSent: ['merchant', 'notes'] },
    { ...ready(), billingCurrency: 'not-currency' },
    { status: 'ready', merchant: 'PRIVATE-QUERY' },
  ])('refuses invalid public response DTO without forwarding private payload: %j', async (result) => {
    const requests = setup(() => new Response(JSON.stringify(okEnvelope(result))));
    const output = JSON.parse(await main(['merchant', 'research', 'preview', ...queryArgs, '--json']));
    expect(output.error.code).toBe('invalid_server_response');
    expect(JSON.stringify(output)).not.toContain('PRIVATE-');
    expect(requests).toHaveLength(1);
  });

  it('requires a human session for complete optimistic space policy replacement, never a delegated key', async () => {
    const value = { mode: 'local-only', allowedProviderIds: [], maxSearchesPerDay: 0, maxSpendMinorUnitsPerMonth: 0, billingCurrency: 'USD', cacheTtlHours: 24 };
    const policyView = { scope: { spaceId: 'spc_selected', budgetId: 'budget-selected', connectionId: 'merchant:space-policy' }, version: 4, generation: 4, value };
    const requests = setup(() => new Response(JSON.stringify(okEnvelope(policyView))));
    const args = ['merchant', 'space-policy', 'set', '--expected-version', '3', '--policy', JSON.stringify(value), '--json'];
    expect(JSON.parse(await main(args)).error.code).toBe('human_session_required');
    expect(requests).toHaveLength(0);
    vi.stubEnv('BALANCEFRAME_SESSION_COOKIE', 'balanceframe_session=human; balanceframe_reauth=proof');
    expect(JSON.parse(await main(args)).result).toEqual(policyView);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url.pathname).toBe('/api/merchant/space-policy');
    expect(requests[0]!.method).toBe('PUT');
    expect(requests[0]!.headers.has('authorization')).toBe(false);
    expect(requests[0]!.headers.get('origin')).toBe('https://balanceframe.example');
    expect(JSON.parse(requests[0]!.body!)).toEqual({ expectedVersion: 3, value });
    expect(JSON.parse(await main(['merchant', 'space-policy', 'get', '--json'])).result).toEqual(policyView);
    expect(requests[1]!.method).toBe('GET');
    expect(parseArgs(['merchant', 'space-policy', 'set', '--expected-version', '9007199254740993', '--policy', '{}']).ok).toBe(false);
  });

  it('never falls back to Actual or environment actor authority when research lacks authentication or selected space', async () => {
    const requests = setup();
    vi.stubEnv('BALANCEFRAME_API_KEY', '');
    expect(JSON.parse(await main(['merchant', 'research', 'preview', ...queryArgs, '--json'])).status).toBe('error');
    vi.stubEnv('BALANCEFRAME_API_KEY', 'bf_test_secret');
    vi.stubEnv('BALANCEFRAME_SPACE_ID', '');
    expect(JSON.parse(await main(['merchant', 'research', 'preview', ...queryArgs, '--json'])).status).toBe('error');
    expect(requests).toHaveLength(0);
  });
});
