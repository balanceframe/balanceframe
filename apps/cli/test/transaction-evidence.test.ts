import { afterEach, describe, expect, it, vi } from 'vitest';
import { main, parseArgs } from '../src/index';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fixture from '../../../protocol/fixtures/transaction-evidence.json';

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('transaction evidence CLI', () => {
  it.each([
    [
      'allocation-preview',
      '/api/evidence/settlement-preview',
      {
        resolutionHash: 'a'.repeat(64),
        targetTransactionId: 'actual-1',
        receiptIds: ['receipt-1', 'receipt-2'],
        lineCategories: [{ receiptId: 'receipt-1', lineId: 'line-1', categoryId: 'food' }],
      },
    ],
    ['proposal', '/api/evidence/proposal', { resolutionHash: 'a'.repeat(64), eventId: 'event-1' }],
    ['settlements', '/api/evidence/settlement-targets', { resolutionHash: 'a'.repeat(64), eventId: 'event-1', accountId: 'checking' }],
    [
      'propose-candidate',
      '/api/evidence/rules/from-candidate',
      { connectorId: 'retail', accountId: 'checking', candidateHash: 'a'.repeat(64) },
    ],
  ])(
    'submits %s selectors without accepting caller-authored financial effects',
    async (action, target, selector) => {
    const directory = mkdtempSync(join(tmpdir(), 'evidence-selector-cli-'));
    vi.stubEnv('BALANCEFRAME_SERVER_URL', 'https://balanceframe.test');
    vi.stubEnv('BALANCEFRAME_API_KEY', 'test-only-key');
    vi.stubEnv('BALANCEFRAME_SESSION_COOKIE', '');
    vi.stubEnv('BALANCEFRAME_SPACE_ID', 'space');
    try {
      const path = join(directory, 'selector.json'); writeFileSync(path, JSON.stringify(selector));
      const request = vi.fn(async () => new Response(JSON.stringify({ schemaVersion: '1', requestId: 'r', dataFreshness: null, authorization: null, status: 'ok', result: { proposalId: 'proposal-1', transactions: [] }, error: null })));
      vi.stubGlobal('fetch', request);
      expect(JSON.parse(await main(['evidence', action, '--file', path])).status).toBe('ok');
      expect(new URL(request.mock.calls[0]![0]).pathname).toBe(target);
      expect(JSON.parse(request.mock.calls[0]![1].body)).toEqual(selector);
      writeFileSync(path, JSON.stringify({ ...selector, ledgerEffect: { amount: 'forged' }, actorId: 'forged' }));
      expect(JSON.parse(await main(['evidence', action, '--file', path])).error.code).toBe('invalid_evidence_file');
      expect(request).toHaveBeenCalledTimes(1);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  },
  );
  it.each([
    ['list', undefined, '/api/evidence'],
    ['health', undefined, '/api/evidence/health'],
    ['rules', undefined, '/api/evidence/rules'],
    ['targets', undefined, '/api/evidence/targets'],
    ['export', undefined, '/api/evidence/export'],
    ['show', 'document /one', '/api/evidence/document%20%2Fone'],
  ])('reads %s through selected-space server authority', async (action, id, path) => {
    vi.stubEnv('BALANCEFRAME_SERVER_URL', 'https://balanceframe.test');
    vi.stubEnv('BALANCEFRAME_API_KEY', 'test-only-api-key');
    vi.stubEnv('BALANCEFRAME_SESSION_COOKIE', '');
    vi.stubEnv('BALANCEFRAME_SPACE_ID', 'space-selected');
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            schemaVersion: '1',
            requestId: 'server',
            status: 'ok',
            dataFreshness: null,
            authorization: {
              actorId: 'server-actor',
              capability: 'normalized-evidence',
              allowed: true,
            },
            result: {
              documents: [],
              exactAmount: { minorUnits: '9223372036854775807', currency: 'JPY' },
            },
            error: null,
          }),
        ),
    );
    vi.stubGlobal('fetch', request);
    const value = JSON.parse(await main(['evidence', action, ...(id ? [id] : []), '--json']));
    expect(value.status).toBe('ok');
    expect(value.result.exactAmount.minorUnits).toBe('9223372036854775807');
    const [url, init] = request.mock.calls[0]! as unknown as [URL, RequestInit];
    expect(new URL(url).pathname).toBe(path);
    expect(new Headers(init.headers).get('x-balanceframe-space')).toBe('space-selected');
  });

  it('validates source-import files and dispatches only current-space intent; resolution uses server policy', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'evidence-cli-'));
    directories.push(directory);
    const path = join(directory, 'import.json');
    const input = {
      connectorId: 'local-wallet',
      sourceId: 'statement',
      sourceKind: 'wallet',
      mediaType: 'application/json',
      sourceTimestamp: '2026-10-15T12:00:00Z',
      content: JSON.stringify(fixture),
    };
    writeFileSync(path, JSON.stringify(input));
    vi.stubEnv('BALANCEFRAME_SERVER_URL', 'https://balanceframe.test');
    vi.stubEnv('BALANCEFRAME_API_KEY', 'test-only-key');
    vi.stubEnv('BALANCEFRAME_SESSION_COOKIE', '');
    vi.stubEnv('BALANCEFRAME_SPACE_ID', 'space');
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            schemaVersion: '1',
            requestId: 'r',
            status: 'ok',
            dataFreshness: null,
            authorization: null,
            result: { accepted: true },
            error: null,
          }),
        ),
    );
    vi.stubGlobal('fetch', request);
    expect(JSON.parse(await main(['evidence', 'import', '--file', path])).status).toBe('ok');
    expect(JSON.parse(request.mock.calls[0]![1].body)).toMatchObject(input);
    expect(JSON.parse(await main(['evidence', 'resolve'])).status).toBe('ok');
    expect(JSON.parse(request.mock.calls.at(-1)![1].body)).toEqual({});
    writeFileSync(path, JSON.stringify({ ...input, actorId: 'forged' }));
    expect(JSON.parse(await main(['evidence', 'import', '--file', path])).error.code).toBe(
      'invalid_evidence_file',
    );
    expect(request).toHaveBeenCalledTimes(2);
    writeFileSync(path, 'not-json');
    expect(JSON.parse(await main(['evidence', 'import', '--file', path])).error.code).toBe(
      'invalid_evidence_file',
    );
  });

  it('keeps exact item-rule files separate from source imports and uses fresh human transport for decisions', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'evidence-rule-cli-'));
    directories.push(directory);
    const path = join(directory, 'rule.json');
    vi.stubEnv('BALANCEFRAME_SERVER_URL', 'https://balanceframe.test');
    vi.stubEnv('BALANCEFRAME_API_KEY', '');
    vi.stubEnv('BALANCEFRAME_SESSION_COOKIE', 'test-only-session');
    vi.stubEnv('BALANCEFRAME_SPACE_ID', 'selected-space');
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            schemaVersion: '1',
            requestId: 'r',
            status: 'ok',
            dataFreshness: null,
            authorization: null,
            result: {},
            error: null,
          }),
        ),
    );
    vi.stubGlobal('fetch', request);
    const input = {
      connectorId: 'retail',
      accountId: 'checking',
      fundingInstrumentId: 'card',
      counterparty: 'Store A',
      sku: 'sku-1',
      normalizedDescription: null,
      categoryId: 'food',
    };
    writeFileSync(path, JSON.stringify(input));
    expect(JSON.parse(await main(['evidence', 'propose-rule', '--file', path])).status).toBe('ok');
    expect(JSON.parse(request.mock.calls.at(-1)![1].body)).toEqual(input);
    const calls = request.mock.calls.length;
    for (const counterparty of [undefined, null, '', '   ']) {
      writeFileSync(path, JSON.stringify({ ...input, counterparty }));
      expect(JSON.parse(await main(['evidence', 'propose-rule', '--file', path])).error.code).toBe(
      'invalid_evidence_file',
    );
    }
    expect(request).toHaveBeenCalledTimes(calls);
    const decision = { proposalId: 'rule', payloadHash: 'a'.repeat(64) };
    writeFileSync(path, JSON.stringify(decision));
    for (const action of ['approve-rule', 'revoke-rule']) {
      expect(JSON.parse(await main(['evidence', action, '--file', path])).status).toBe('ok');
      expect(JSON.parse(request.mock.calls.at(-1)![1].body)).toEqual(decision);
      expect(new Headers(request.mock.calls.at(-1)![1].headers).get('origin')).toBe(
        'https://balanceframe.test',
      );
    }
    expect(
      JSON.parse(await main(['evidence', 'suggest-items', '--account-id', 'checking'])).status,
    ).toBe('ok');
    expect(new URL(request.mock.calls.at(-1)![0]).pathname).toBe('/api/evidence/rules/suggestions');
    writeFileSync(path, JSON.stringify({ ...input, merchant: 'all' }));
    expect(JSON.parse(await main(['evidence', 'propose-rule', '--file', path])).error.code).toBe(
      'invalid_evidence_file',
    );
  });

  it.each([
    ['evidence', 'show'],
    ['evidence', 'health', 'extra'],
    ['evidence', 'list', '--actor-id', 'someone'],
    ['evidence', 'suggest-items'],
    ['evidence', 'approve-rule', '--file', 'a', '--actor-id', 'forged'],
    ['evidence', 'resolve', '--file', 'a.json', '--space-id', 'forged'],
    ['evidence', 'import', '--file', 'a.json', '--connector', 'unknown'],
    [
      'evidence',
      'import',
      '--file',
      'a.json',
      '--connector',
      'wallet',
      '--verified-sender',
      'true',
    ],
  ])('rejects malformed or authority-bearing arguments %j', (...args) => {
    expect(parseArgs(args).ok).toBe(false);
  });
});

it('reads explicit item outcomes and repeated candidates without activating rules', async () => {
  vi.stubEnv('BALANCEFRAME_SERVER_URL', 'https://balanceframe.test');
  vi.stubEnv('BALANCEFRAME_API_KEY', '');
  vi.stubEnv('BALANCEFRAME_SESSION_COOKIE', 'test-session');
  vi.stubEnv('BALANCEFRAME_SPACE_ID', 'selected-space');
  const request = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          schemaVersion: '1',
          requestId: 'r',
          status: 'ok',
          dataFreshness: null,
          authorization: null,
          result: [],
          error: null,
        }),
      ),
  );
  vi.stubGlobal('fetch', request);
  for (const [command, path] of [
    ['item-outcomes', 'outcomes'],
    ['rule-candidates', 'candidates'],
  ]) {
    const result = JSON.parse(
      await main(['evidence', command!, '--connector-id', 'retail', '--account-id', 'checking']),
    );
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'ok' });
    expect(new URL(request.mock.calls.at(-1)![0]).pathname).toBe(`/api/evidence/rules/${path}`);
    expect(JSON.parse(request.mock.calls.at(-1)![1].body)).toEqual({
      connectorId: 'retail',
      accountId: 'checking',
    });
  }
});

it('sends explicit line-category decisions while rejecting client-selected reviewer provenance', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'evidence-item-review-cli-'));
  directories.push(directory);
  const path = join(directory, 'decision.json');
  vi.stubEnv('BALANCEFRAME_SERVER_URL', 'https://balanceframe.test');
  vi.stubEnv('BALANCEFRAME_API_KEY', '');
  vi.stubEnv('BALANCEFRAME_SESSION_COOKIE', 'test-session');
  vi.stubEnv('BALANCEFRAME_SPACE_ID', 'selected-space');
  const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            schemaVersion: '1',
            requestId: 'r',
            status: 'ok',
            dataFreshness: null,
            authorization: null,
            result: {},
            error: null,
          }),
        ),
    );
  vi.stubGlobal('fetch', request);
  const line = { receiptId: 'receipt', lineId: 'line', accountId: 'checking', categoryId: 'food' };
  const input = {
    resolutionHash: 'a'.repeat(64),
    relationships: [],
    itemCategoryDecisions: [line],
  };
  writeFileSync(path, JSON.stringify(input));
  expect(JSON.parse(await main(['evidence', 'decision', '--file', path])).status).toBe('ok');
  expect(JSON.parse(request.mock.calls.at(-1)![1].body).itemCategoryDecisions).toEqual([line]);
  writeFileSync(
    path,
    JSON.stringify({
      ...input,
      itemCategoryDecisions: [{ ...line, actorId: 'forged', reviewedAt: new Date().toISOString() }],
    }),
  );
  expect(JSON.parse(await main(['evidence', 'decision', '--file', path])).error.code).toBe(
    'invalid_evidence_file',
  );
  expect(request).toHaveBeenCalledTimes(1);
});

it('saves allocation selectors only through the fresh human endpoint', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'evidence-allocation-cli-'));
  directories.push(directory);
  const path = join(directory, 'allocation.json');
  const input = {
    resolutionHash: 'a'.repeat(64),
    allocationHash: 'b'.repeat(64),
    targetTransactionId: 'actual-1',
    receiptIds: ['receipt-1', 'receipt-2'],
    lineCategories: [{ receiptId: 'receipt-1', lineId: 'line-1', categoryId: 'food' }],
  };
  writeFileSync(path, JSON.stringify(input));
  vi.stubEnv('BALANCEFRAME_SERVER_URL', 'https://balanceframe.test');
  vi.stubEnv('BALANCEFRAME_API_KEY', '');
  vi.stubEnv('BALANCEFRAME_SESSION_COOKIE', 'test-session');
  vi.stubEnv('BALANCEFRAME_SPACE_ID', 'space');
  const request = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          schemaVersion: '1',
          requestId: 'r',
          dataFreshness: null,
          authorization: null,
          status: 'ok',
          result: {},
          error: null,
        }),
      ),
  );
  vi.stubGlobal('fetch', request);
  expect(JSON.parse(await main(['evidence', 'allocation-save', '--file', path])).status).toBe('ok');
  expect(new URL(request.mock.calls[0]![0]).pathname).toBe('/api/evidence/settlement-allocation');
  expect(JSON.parse(request.mock.calls[0]![1].body)).toEqual(input);
  expect(new Headers(request.mock.calls[0]![1].headers).get('origin')).toBe(
    'https://balanceframe.test',
  );
  writeFileSync(path, JSON.stringify({ ...input, ledgerEffect: { amount: 'forged' } }));
  expect(JSON.parse(await main(['evidence', 'allocation-save', '--file', path])).error.code).toBe(
    'invalid_evidence_file',
  );
  expect(request).toHaveBeenCalledTimes(1);
});

it('submits contextual item criteria for historical simulation and rejects mixed or model-authored scope', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'context-item-cli-'));
  directories.push(directory);
  const path = join(directory, 'rule.json');
  vi.stubEnv('BALANCEFRAME_SERVER_URL', 'https://balanceframe.test');
  vi.stubEnv('BALANCEFRAME_API_KEY', 'test-only-key');
  vi.stubEnv('BALANCEFRAME_SPACE_ID', 'space');
  vi.stubEnv('BALANCEFRAME_SESSION_COOKIE', '');
  const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            schemaVersion: '1',
            requestId: 'r',
            status: 'ok',
            dataFreshness: null,
            authorization: null,
            result: {},
            error: null,
          }),
        ),
    );
  vi.stubGlobal('fetch', request);
  const body = {
    connectorId: 'retail',
    accountId: 'checking',
    fundingInstrumentId: 'card',
    counterparty: 'Store A',
    sku: null,
    normalizedDescription: null,
    categoryId: 'food',
    criterion: { kind: 'department', value: 'produce' },
  };
  writeFileSync(path, JSON.stringify(body));
  expect(JSON.parse(await main(['evidence', 'propose-rule', '--file', path])).status).toBe('ok');
  expect(JSON.parse(request.mock.calls[0]![1].body)).toEqual(body);
  for (const invalid of [
    { ...body, sku: 'also-exact' },
    { ...body, criterion: { kind: 'opaque_model', value: 'produce' } },
    { ...body, criterion: { kind: 'department', value: ' ' } },
  ]) {
    writeFileSync(path, JSON.stringify(invalid));
    expect(JSON.parse(await main(['evidence', 'propose-rule', '--file', path])).error.code).toBe(
      'invalid_evidence_file',
    );
  }
  expect(request).toHaveBeenCalledTimes(1);
});
