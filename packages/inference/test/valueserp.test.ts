import type { MerchantResearchRequest } from '../src/merchant-research';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMerchantResearchRequest, merchantResearchResultSchema } from '../src/merchant-research';
import { ValueSerpProvider } from '../src/providers/valueserp';

const key = 'server-only-test-secret';
const at = '2026-10-04T12:00:00.000Z';
const organic = { title: 'MUJI', link: 'https://example.com/muji', snippet: 'Public business information' };
const payload = (results: unknown[] = [organic]) => ({ request_info: { success: true, credits_used_this_request: 1 }, organic_results: results });
const json = (body: unknown, init?: ConstructorParameters<typeof Response>[1]) => new Response(JSON.stringify(body), init);
const request = () => createMerchantResearchRequest({ merchant: 'MUJI', locale: null });
const now = () => new Date(at);
function provider(fetchFn: typeof fetch) { return new ValueSerpProvider({ apiKey: key, fetchFn, now }); }
function expectFailure(result: unknown, code: string, billing = 'uncertain') {
  expect(result).toEqual({ status: 'failed', providerId: 'valueserp', providerVersion: 'valueserp-search/1', retrievedAt: at, code, billing });
  expect(merchantResearchResultSchema.safeParse(result).success).toBe(true);
  expect(JSON.stringify(result)).not.toContain(key);
  expect(JSON.stringify(result)).not.toContain('MUJI');
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('fixed-origin optional ValueSerp research', () => {
  it('sends only the minimal fixed GET allowlist and returns typed clock provenance', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(json(payload()));
    const adapter = provider(fetchFn);
    expect(adapter.providerInfo).toEqual({ id: 'valueserp', name: 'ValueSerp', locality: 'external', supportedCapabilities: ['merchantResearch'], endpoint: 'https://api.valueserp.com/search', authType: 'api-key', model: null });
    const result = await adapter.research(request());
    expect(result).toEqual({ status: 'ok', providerId: 'valueserp', providerVersion: 'valueserp-search/1', retrievedAt: at, sources: [{ url: organic.link, title: organic.title, snippet: organic.snippet }], confidence: 'uncalibrated' });
    expect(merchantResearchResultSchema.parse(result)).toEqual(result);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [input, init] = fetchFn.mock.calls[0]!;
    const url = new URL(String(input));
    expect(url.origin + url.pathname).toBe('https://api.valueserp.com/search');
    expect(Object.fromEntries(url.searchParams)).toEqual({ api_key: key, q: 'MUJI', output: 'json', num: '10' });
    expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.body).toBeUndefined();
    expect(init?.headers).toBeUndefined();
  });

  it.each(['US', 'CA', 'GB'])('maps only explicit coarse locale %s to gl', async (locale) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(json(payload([])));
    const result = await provider(fetchFn).research(createMerchantResearchRequest({ merchant: 'MUJI', locale }));
    expect(result.status).toBe('ok');
    const url = new URL(String(fetchFn.mock.calls[0]![0]));
    expect(Object.fromEntries(url.searchParams)).toEqual({ api_key: key, q: 'MUJI', output: 'json', num: '10', gl: locale.toLowerCase() });
  });

  it('accepts empty sources and materializes only ten validated organic results, never page-fetching', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(json(payload([...Array.from({ length: 10 }, () => organic), { link: 'javascript:bad', title: 1 }])));
    const result = await provider(fetchFn).research(request());
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.sources).toHaveLength(10);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('defaults a documented absent snippet to empty text but rejects malformed supplied snippets', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(json(payload([{ title: 'MUJI', link: organic.link }]))).mockResolvedValueOnce(json(payload([{ ...organic, snippet: 1 }])));
    const adapter = provider(fetchFn);
    const result = await adapter.research(request());
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.sources[0]?.snippet).toBe('');
    expectFailure(await adapter.research(request()), 'invalid_response');
  });

  it('rejects invalid runtime input or pre-cancellation before external dispatch', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const adapter = provider(fetchFn);
    expectFailure(await adapter.research({ ...request(), merchant: 'Cafe 4111 1111 1111 1111' }), 'invalid_request', 'not_dispatched');
    expectFailure(await adapter.research({ ...request(), amount: '123' } as MerchantResearchRequest), 'invalid_request', 'not_dispatched');
    const controller = new AbortController(); controller.abort(new Error(`${key} MUJI`));
    expectFailure(await adapter.research({ ...request(), signal: controller.signal }), 'cancelled', 'not_dispatched');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects empty, whitespace or malformed credentials without reflecting them', () => {
    for (const apiKey of ['', ' ', 'secret\nkey', 'secret key']) {
      expect(() => new ValueSerpProvider({ apiKey })).toThrow('Invalid ValueSerp configuration');
    }
  });

  it('keeps configured credentials out of serialized adapter metadata', () => {
    expect(JSON.stringify(provider(vi.fn<typeof fetch>()))).not.toContain(key);
  });
  it.each([
    null, {}, { request_info: { success: 'true' }, organic_results: [] },
    { request_info: { success: false }, organic_results: [] },
    { request_info: { success: true } }, { request_info: { success: true }, organic_results: {} },
    payload([{ ...organic, link: 'https://user:secret@example.com' }]),
    payload([{ ...organic, title: 'x'.repeat(257) }]), payload([{ ...organic, snippet: 'x'.repeat(1001) }]),
  ])('rejects malformed documented response shape %#', async (body) => {
    expectFailure(await provider(vi.fn<typeof fetch>().mockResolvedValue(json(body))).research(request()), 'invalid_response');
  });

  it('discards documented request metadata and pagination without retaining q, key or URLs', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input) => json({
      ...payload(), search_metadata: { json_url: String(input), html_url: `${String(input)}&output=html` },
      search_parameters: { q: 'MUJI' }, pagination: { api_pagination: { next: `${String(input)}&page=2` } },
    }));
    const result = await provider(fetchFn).research(request());
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(Object.keys(result)).toEqual(['status', 'providerId', 'providerVersion', 'retrievedAt', 'sources', 'confidence']);
    expect(JSON.stringify(result)).not.toContain(key);
    expect(JSON.stringify(result)).not.toContain('api.valueserp.com');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('refuses selected sources reflecting raw/encoded configured secrets or provider request links', async () => {
    for (const body of [payload([{ ...organic, snippet: key }]), payload([{ ...organic, title: '%73erver-only-test-secret' }]), payload([{ ...organic, link: `https://example.com/?token=${encodeURIComponent(key)}` }]), payload([{ ...organic, link: 'https://example.com/?api_key=other-secret' }]), payload([{ ...organic, link: 'https://api.valueserp.com/search?q=MUJI&output=json' }])]) {
      expectFailure(await provider(vi.fn<typeof fetch>().mockResolvedValue(json(body))).research(request()), 'invalid_response');
    }
  });

  it('suppresses raw fetch/parser/stream exceptions and does not retry or log', async () => {
    const logger = vi.spyOn(console, 'error');
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(new Error(`https://api.valueserp.com/search?api_key=${key}&q=MUJI`));
    expectFailure(await provider(fetchFn).research(request()), 'unavailable');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expectFailure(await provider(vi.fn<typeof fetch>().mockResolvedValue(new Response('not JSON MUJI'))).research(request()), 'invalid_response');
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error(key)); } });
    expectFailure(await provider(vi.fn<typeof fetch>().mockResolvedValue(new Response(body))).research(request()), 'invalid_response');
    expect(logger).not.toHaveBeenCalled();
  });

  it('cancels refused HTTP and redirect bodies, always retaining uncertain billing', async () => {
    for (const [status, code] of [[500, 'http_error'], [302, 'redirect_refused']] as const) {
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({ cancel });
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status }));
      expectFailure(await provider(fetchFn).research(request()), code);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    }
    const redirected = json(payload()); Object.defineProperty(redirected, 'redirected', { value: true });
    expectFailure(await provider(vi.fn<typeof fetch>().mockResolvedValue(redirected)).research(request()), 'redirect_refused');
  });

  it('bounds actual streamed bytes independently of absent or misleading Content-Length', async () => {
    for (const contentLength of [undefined, '1', '262145']) {
      const cancel = vi.fn(); let pulls = 0;
      const body = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(131073)); }, cancel });
      const headers = contentLength ? { 'Content-Length': contentLength } : undefined;
      expectFailure(await provider(vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { headers }))).research(request()), 'response_too_large');
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(pulls).toBeLessThanOrEqual(3);
    }
  });

  it('accepts exactly 256KiB and decodes split UTF-8 chunks', async () => {
    const text = JSON.stringify(payload([{ ...organic, title: 'Café' }]));
    const padded = text + ' '.repeat(262144 - new TextEncoder().encode(text).length);
    const bytes = new TextEncoder().encode(padded);
    const split = bytes.indexOf(0xc3) + 1;
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes.slice(0, split)); controller.enqueue(bytes.slice(split)); controller.close(); } });
    const result = await provider(vi.fn<typeof fetch>().mockResolvedValue(new Response(body))).research(request());
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.sources[0]?.title).toBe('Café');
  });

  it('enforces ten-second deadline even when fetch ignores AbortSignal', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>(() => {}));
    const pending = provider(fetchFn).research(request());
    await vi.advanceTimersByTimeAsync(9999);
    expect(fetchFn.mock.calls[0]![1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expectFailure(await pending, 'timeout');
    expect(fetchFn.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  });

  it('cancels a late fetch body after an already returned timeout', async () => {
    vi.useFakeTimers();
    let complete: ((response: Response) => void) | undefined;
    const cancel = vi.fn();
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>((resolve) => { complete = resolve; }));
    const pending = provider(fetchFn).research(request());
    await vi.advanceTimersByTimeAsync(10000);
    expectFailure(await pending, 'timeout');
    complete?.(new Response(new ReadableStream<Uint8Array>({ cancel })));
    await Promise.resolve(); await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('covers streamed body stalls with the same deadline and cancels body', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const pending = provider(vi.fn<typeof fetch>().mockResolvedValue(new Response(body))).research(request());
    await vi.advanceTimersByTimeAsync(10000);
    expectFailure(await pending, 'timeout');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('cancels in-flight research without exposing caller abort reason', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const controller = new AbortController();
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    const pending = provider(fetchFn).research({ ...request(), signal: controller.signal });
    await Promise.resolve(); await Promise.resolve();
    controller.abort(new Error(`${key} MUJI`));
    expectFailure(await pending, 'cancelled');
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
