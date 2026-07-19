/**
 * OpenAI-compatible provider adapter.
 *
 * Implements the ProviderAdapter interface for any OpenAI-compatible API
 * endpoint (OpenAI, Azure OpenAI, local LLM servers with OpenAI-compatible
 * chat completions API, etc.).
 *
 * No hardcoded credentials. The caller injects the API key and endpoint
 * at construction time — secrets never leak into the adapter itself.
 */
import type { ProviderAdapter } from './types';
import type { ClassifyRequest, ClassificationResult, ProviderInfo } from '../types';

/** Configuration for the OpenAI-compatible provider adapter. */
export interface OpenAIProviderConfig {
  providerId?: string;
  name?: string;
  endpoint: string;
  apiKey: string;
  model: string;
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
  private readonly fetchFn: typeof fetch;

  constructor(config: OpenAIProviderConfig) {
    const id = config.providerId ?? 'openai-default';
    this.providerId = id;
    this.providerInfo = {
      id,
      name: config.name ?? 'OpenAI-Compatible',
      locality: 'external',
      supportedCapabilities: ['classification', 'merchantResearch'],
      endpoint: config.endpoint,
      authType: 'api-key',
      model: config.model,
    };
    this.endpoint = config.endpoint;
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.fetchFn = config.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  async classify(request: ClassifyRequest): Promise<ClassificationResult> {
    const response = await this.fetchFn(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(this.buildChatRequest(request)),
    });

    if (!response.ok) {
      throw new Error(`OpenAI provider returned status ${response.status}`);
    }

    const body = await response.json();
    return this.parseResponse(body);
  }

  /**
   * Build the chat completions request payload.
   * Override in subclass to customize the prompt.
   */
  protected buildChatRequest(request: ClassifyRequest): Record<string, unknown> {
    return {
      model: this.model,
      messages: [
        {
          role: 'system',
          content: 'You are a transaction categorization assistant. Given transaction details, respond with a JSON object containing: categoryId (string), confidence (number 0-1 or null), alternatives (array of {categoryId, reason}), rationale (string), model (string). Only respond with the JSON object, no other text.',
        },
        {
          role: 'user',
          content: `Categorize this transaction:\nMerchant: ${request.rawMerchant ?? request.normalizedMerchant ?? 'unknown'}\nAmount: ${request.amountMinorUnits} ${request.currency}\nDate: ${request.date}\nCategory names: ${JSON.stringify(request.categoryNames)}`,
        },
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    };
  }

  /**
   * Parse and validate the API response.
   * Throws on malformed JSON or missing required fields.
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
    return {
      categoryId: String(parsed.categoryId ?? ''),
      confidence: parsed.confidence != null ? Number(parsed.confidence) : null,
      alternatives: Array.isArray(parsed.alternatives) ? parsed.alternatives : [],
      rationale: String(parsed.rationale ?? ''),
      model: this.model,
    };
  }
}
