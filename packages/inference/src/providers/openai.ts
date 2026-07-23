/**
 * OpenAI-compatible provider adapter.
 *
 * Implements the ProviderAdapter interface for any OpenAI-compatible API
 * endpoint (OpenAI, Azure OpenAI, local LLM servers with OpenAI-compatible
 * chat completions API, etc.).
 *
 * Security hardening:
 * - Endpoint scheme/host validated before sending credentials
 * - Redirects are rejected (credentials never sent to a different origin)
 * - Bounded fetch via AbortSignal from the request context
 * - Configurable Bearer or Api-Key auth
 * - Untrusted data delimiters in prompt construction
 * - No String/Number coercion in response parsing
 *
 * No hardcoded credentials. The caller injects the API key and endpoint
 * at construction time — secrets never leak into the adapter itself.
 */
import type { ProviderAdapter } from './types';
import type { ClassifyRequest, ClassificationResult, ProviderInfo } from '../types';

/**
 * Escape untrusted text for safe embedding in XML-style delimiters.
 * Replaces &, <, >, " and control characters with their XML entities.
 */
function escapeXml(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
    })
    .join('')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Supported auth schemes. */
export type OpenAIAuthType = 'bearer' | 'api-key';

/** Configuration for the OpenAI-compatible provider adapter. */
export interface OpenAIProviderConfig {
  providerId?: string;
  name?: string;
  endpoint: string;
  apiKey: string;
  model: string;
  /** Provider locality — defaults to 'external'. Set 'local' for self-hosted endpoints. */
  locality?: 'local' | 'external';
  /** Auth header scheme — 'bearer' (default) or 'api-key'. */
  authType?: OpenAIAuthType;
  /** Optional fetch override for testing — defaults to global fetch. */
  fetchFn?: typeof fetch;
}

/**
 * OpenAI-compatible provider adapter.
 *
 * Calls the chat completions endpoint with the candidate data and parses
 * the structured JSON response. The caller provides credentials and endpoint.
 */
export class OpenAIProvider implements ProviderAdapter {
  readonly providerId: string;
  readonly providerInfo: ProviderInfo;
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly authType: OpenAIAuthType;
  private readonly fetchFn: typeof fetch;

  constructor(config: OpenAIProviderConfig) {
    // Validate endpoint scheme and host before accepting config
    const parsedUrl = this.validateEndpoint(config.endpoint);

    const id = config.providerId ?? 'openai-default';
    this.providerId = id;
    this.providerInfo = {
      id,
      name: config.name ?? 'OpenAI-Compatible',
      locality: config.locality ?? 'external',
      supportedCapabilities: ['classification', 'merchantResearch'],
      endpoint: config.endpoint,
      authType: config.authType === 'bearer' ? 'bearer' : 'api-key',
      model: config.model,
    };
    this.endpoint = config.endpoint;
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.authType = config.authType === 'bearer' ? 'bearer' : 'api-key';
    this.fetchFn = config.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  async classify(request: ClassifyRequest): Promise<ClassificationResult> {
    const authHeader = this.authType === 'api-key'
      ? `Api-Key ${this.apiKey}`
      : `Bearer ${this.apiKey}`;

    const response = await this.fetchFn(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
      body: JSON.stringify(this.buildChatRequest(request)),
      signal: request.signal,
      redirect: 'error',
    });

    if (response.redirected) {
      throw new Error('OpenAI provider rejected: redirect detected');
    }

    if (!response.ok) {
      throw new Error(`OpenAI provider returned status ${response.status}`);
    }

    const body = await response.json();
    return this.parseResponse(body);
  }

  /**
   * Build the chat completions request payload.
   * Override in subclass to customize the prompt.
   *
   * Untrusted content is XML-escaped and wrapped in named XML-style
   * delimiters to mitigate prompt injection via transaction data.
   */
  protected buildChatRequest(request: ClassifyRequest): Record<string, unknown> {
    const description = escapeXml(request.description ?? '');
    const notes = escapeXml(request.notes ?? '');
    const importedPayee = escapeXml(request.importedPayee ?? '');
    const merchant = escapeXml(request.rawMerchant ?? request.normalizedMerchant ?? 'unknown');
    const amount = escapeXml(`${request.amountMinorUnits} ${request.currency}`);
    const date = escapeXml(request.date);

    return {
      model: this.model,
      messages: [
        {
          role: 'system',
          content: 'You are a transaction categorization assistant. Given transaction details, respond with a JSON object containing: categoryId (string), confidence (number 0-1 or null), alternatives (array of {categoryId, reason}), rationale (string), model (string). Only respond with the JSON object, no other text.',
        },
        {
          role: 'user',
          content: [
            'Categorize this transaction:',
            `<description>${description}</description>`,
            `<notes>${notes}</notes>`,
            `<importedPayee>${importedPayee}</importedPayee>`,
            `<merchant>${merchant}</merchant>`,
            `<amount>${amount}</amount>`,
            `<date>${date}</date>`,
            `<categoryNames>${escapeXml(JSON.stringify(request.categoryNames))}</categoryNames>`,
            `<categoryGroups>${escapeXml(JSON.stringify(request.categoryGroups))}</categoryGroups>`,
          ].join('\n'),
        },
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    };
  }

  /**
   * Parse and validate the API response.
   * Throws on malformed JSON or missing required fields.
   * Does NOT coerce types — validates them explicitly.
   */
  private parseResponse(body: unknown): ClassificationResult {
    const root = body as Record<string, unknown> | null;
    const choices = root?.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new Error('OpenAI response missing choices[0]');
    }
    const message = (choices[0] as Record<string, unknown> | undefined)?.message;
    if (!message || typeof message !== 'object') {
      throw new Error('OpenAI response missing choices[0].message');
    }
    const content = (message as Record<string, unknown>).content;
    if (typeof content !== 'string') {
      throw new Error('OpenAI response missing choices[0].message.content');
    }
    const parsed = JSON.parse(content);

    // Validate types explicitly — no coercion
    if (typeof parsed.categoryId !== 'string') {
      throw new Error(`OpenAI response: categoryId must be a string, got ${typeof parsed.categoryId}`);
    }
    if (parsed.confidence != null && typeof parsed.confidence !== 'number') {
      throw new Error(`OpenAI response: confidence must be a number or null, got ${typeof parsed.confidence}`);
    }
    if (typeof parsed.rationale !== 'string') {
      throw new Error(`OpenAI response: rationale must be a string, got ${typeof parsed.rationale}`);
    }

    return {
      categoryId: parsed.categoryId,
      confidence: parsed.confidence ?? null,
      alternatives: Array.isArray(parsed.alternatives) ? parsed.alternatives : [],
      rationale: parsed.rationale,
      model: this.model,
    };
  }

  /**
   * Validate endpoint URL: must be https and have a non-empty host.
   * Throws on invalid input before any credentials are sent.
   */
  private validateEndpoint(endpoint: string): URL {
    if (!endpoint.match(/^https:\/\/[^/]/)) {
      throw new Error(`OpenAI provider: invalid endpoint URL "${endpoint}" — must start with https://<host>`);
    }
    let parsed: URL;
    try {
      parsed = new URL(endpoint);
    } catch {
      throw new Error(`OpenAI provider: invalid endpoint URL "${endpoint}"`);
    }
    if (parsed.protocol !== 'https:') {
      throw new Error(`OpenAI provider: endpoint must use https scheme, got "${parsed.protocol}"`);
    }
    if (!parsed.host || parsed.host === '') {
      throw new Error(`OpenAI provider: endpoint must have a non-empty host`);
    }
    return parsed;
  }
}
