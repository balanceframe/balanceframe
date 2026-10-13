import type { MerchantEnrichmentProvider, MerchantResearchFailureCode, MerchantResearchRequest, MerchantResearchResult, MerchantResearchSource } from '../merchant-research.js';
import type { ProviderInfo } from '../types.js';
import { z } from 'zod';
import { merchantResearchRequestSchema, merchantResearchSourceSchema } from '../merchant-research.js';

/** Trusted server-only credentials and deterministic external-I/O seams. */
export interface ValueSerpProviderConfig {
  apiKey: string;
  fetchFn?: typeof fetch;
  now?: () => Date;
}

const endpoint = 'https://api.valueserp.com/search';
const maxBytes = 256 * 1024;
const transportRequestSchema = merchantResearchRequestSchema.extend({
  signal: z.instanceof(AbortSignal).optional(),
});
// Official result fields: https://docs.trajectdata.com/valueserp/search-api/results/google/search
// Metadata/pagination contain q and credential-bearing API URLs; discard them entirely.
const upstreamSchema = z.object({
  request_info: z.object({ success: z.literal(true) }),
  organic_results: z.array(z.unknown()),
});
const organicSourceSchema = z.object({
  link: z.string(),
  title: z.string(),
  snippet: z.string().optional().default(''),
});

/** Optional fixed-origin public-business research adapter. */
export class ValueSerpProvider implements MerchantEnrichmentProvider {
  readonly providerId = 'valueserp';
  readonly providerVersion = 'valueserp-search/1';
  /** Describe the fixed provider without constructing it or supplying credentials. */
  static readonly providerInfo: ProviderInfo = {
    id: 'valueserp', name: 'ValueSerp', locality: 'external',
    supportedCapabilities: ['merchantResearch'], endpoint: 'https://api.valueserp.com/search',
    authType: 'api-key', model: null,
  };
  readonly providerInfo = ValueSerpProvider.providerInfo;

  readonly #apiKey: string;
  readonly #fetchFn: typeof fetch;
  readonly #now: () => Date;

  /** Accept credentials only from trusted server composition, never a client endpoint. */
  constructor(config: ValueSerpProviderConfig) {
    if (typeof config.apiKey !== 'string' || !/^[!-~]{1,512}$/.test(config.apiKey)) {
      throw new Error('Invalid ValueSerp configuration');
    }
    this.#apiKey = config.apiKey;
    this.#fetchFn = config.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.#now = config.now ?? (() => new Date());
  }

  /** Research explicitly reviewed business text with no financial context, retry or page fetch. */
  async research(request: MerchantResearchRequest): Promise<MerchantResearchResult> {
    const failure = (code: MerchantResearchFailureCode, billing: 'not_dispatched' | 'uncertain'): MerchantResearchResult => ({
      status: 'failed', providerId: this.providerId, providerVersion: this.providerVersion,
      retrievedAt: this.#now().toISOString(), code, billing,
    });
    let input: MerchantResearchRequest;
    try {
      const validated = transportRequestSchema.safeParse(request);
      if (!validated.success) return failure('invalid_request', 'not_dispatched');
      input = validated.data;
    } catch {
      return failure('invalid_request', 'not_dispatched');
    }
    if (input.signal?.aborted) return failure('cancelled', 'not_dispatched');

    const url = new URL(endpoint);
    url.searchParams.set('api_key', this.#apiKey);
    url.searchParams.set('q', input.merchant);
    url.searchParams.set('output', 'json');
    url.searchParams.set('num', '10');
    if (input.locale !== null) url.searchParams.set('gl', input.locale.toLowerCase());

    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let body: ReadableStream<Uint8Array> | null = null;
    let abortCode: 'timeout' | 'cancelled' | null = null;
    let stop: ((result: MerchantResearchResult) => void) | undefined;
    const stopped = new Promise<MerchantResearchResult>((resolve) => { stop = resolve; });
    const refuse = (code: MerchantResearchFailureCode): MerchantResearchResult => {
      void (reader ? reader.cancel() : body?.cancel())?.catch(() => {});
      return failure(code, 'uncertain');
    };
    const abort = (code: 'timeout' | 'cancelled') => {
      if (controller.signal.aborted) return;
      abortCode = code;
      controller.abort();
      void (reader ? reader.cancel() : body?.cancel())?.catch(() => {});
      stop?.(failure(code, 'uncertain'));
    };
    const onCancel = () => abort('cancelled');
    input.signal?.addEventListener('abort', onCancel, { once: true });
    const deadline = setTimeout(() => abort('timeout'), 10_000);
    const work = async (): Promise<MerchantResearchResult> => {
      let code: MerchantResearchFailureCode = 'unavailable';
      try {
        const response = await this.#fetchFn(url, {
          method: 'GET', redirect: 'error', credentials: 'omit', signal: controller.signal,
        });
        body = response.body;
        if (controller.signal.aborted) return refuse(abortCode ?? 'cancelled');
        code = 'invalid_response';
        if (response.redirected || (response.status >= 300 && response.status < 400)) {
          return refuse('redirect_refused');
        }
        if (!response.ok) return refuse('http_error');
        const length = response.headers.get('Content-Length');
        if (length !== null && /^\d+$/.test(length) && Number(length) > maxBytes) {
          return refuse('response_too_large');
        }
        if (body === null) return refuse('invalid_response');
        reader = body.getReader();
        const decoder = new TextDecoder('utf-8', { fatal: true });
        const parts: string[] = [];
        let bytes = 0;
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > maxBytes) return refuse('response_too_large');
          parts.push(decoder.decode(chunk.value, { stream: true }));
        }
        parts.push(decoder.decode());
        if (controller.signal.aborted) return refuse(abortCode ?? 'cancelled');
        const upstream = upstreamSchema.safeParse(JSON.parse(parts.join('')));
        if (!upstream.success) return refuse('invalid_response');
        const sources: MerchantResearchSource[] = [];
        for (const raw of upstream.data.organic_results.slice(0, 10)) {
          const organic = organicSourceSchema.safeParse(raw);
          if (!organic.success) return refuse('invalid_response');
          const source = merchantResearchSourceSchema.safeParse({
            url: organic.data.link, title: organic.data.title, snippet: organic.data.snippet,
          });
          if (!source.success) return refuse('invalid_response');
          for (const text of [source.data.url, source.data.title, source.data.snippet]) {
            let decoded = text;
            for (;;) {
              if (decoded.includes(this.#apiKey)
                || /https?:\/\/api\.valueserp\.com\/search\b/i.test(decoded)
                || /\b(?:api[_-]?key|access[_-]?token|authorization)\s*[=:]/i.test(decoded)) {
                return refuse('invalid_response');
              }
              const next = decoded.replace(/%([0-9a-f]{2})/gi, (_match: string, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
              if (next === decoded) break;
              decoded = next;
            }
          }
          sources.push(source.data);
        }
        return {
          status: 'ok', providerId: this.providerId, providerVersion: this.providerVersion,
          retrievedAt: this.#now().toISOString(), sources, confidence: 'uncalibrated',
        };
      } catch {
        return refuse(abortCode ?? code);
      } finally {
        reader?.releaseLock();
      }
    };
    try {
      return await Promise.race([work(), stopped]);
    } finally {
      clearTimeout(deadline);
      input.signal?.removeEventListener('abort', onCancel);
    }
  }
}
