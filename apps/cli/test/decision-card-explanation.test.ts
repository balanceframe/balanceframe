import { afterEach, describe, expect, it, vi } from 'vitest';
import { main, parseArgs } from '../src/index.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe('purchase explain CLI JSON parity', () => {
  const args = [
    'purchase',
    'explain',
    '--category-id',
    'food',
    '--amount',
    '2000',
    '--currency',
    'USD',
    '--json',
  ];
  it('sends only purchase intent to the ordinary authenticated selected-space endpoint', async () => {
    const result = {
      card: { outcome: 'insufficient_data' },
      explanation: { status: 'manual', code: 'disabled' },
    };
    const response = {
      schemaVersion: '1',
      requestId: 'server-request',
      status: 'ok',
      dataFreshness: null,
      authorization: {
        actorId: 'verified-user',
        capability: 'affordability:evaluate',
        allowed: true,
      },
      result,
      error: null,
    };
    vi.stubEnv('BALANCEFRAME_SERVER_URL', 'https://source.example');
    vi.stubEnv('BALANCEFRAME_SPACE_ID', 'selected-space');
    vi.stubEnv('BALANCEFRAME_API_KEY', 'synthetic-source-key');
    vi.stubEnv('BALANCEFRAME_SESSION_COOKIE', '');
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(response)));
    vi.stubGlobal('fetch', fetchFn);
    expect(JSON.parse(await main(args))).toEqual(response);
    const [url, request] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe('https://source.example/api/purchase/explain');
    expect(request?.method).toBe('POST');
    expect(new Headers(request?.headers).get('x-balanceframe-space')).toBe('selected-space');
    expect(new Headers(request?.headers).get('origin')).toBe('https://source.example');
    expect(JSON.parse(String(request?.body))).toEqual({
      kind: 'purchase',
      categoryId: 'food',
      amount: { minorUnits: '2000', currency: 'USD' },
    });
  });
  it.each(['--endpoint', '--actor-id', '--card', '--policy', '--unknown'])(
    'rejects client authority and unsupported flag %s',
    (flag) => {
      expect(parseArgs([...args, flag, 'forged']).ok).toBe(false);
    },
  );
});
