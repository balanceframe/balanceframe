/**
 * Local (on-device) provider adapter.
 *
 * Runs classification entirely locally — no network egress. This adapter
 * uses a simple keyword/rule-based fallback when no real local model is
 * configured, but is designed to be replaced with an ONNX/TFLite/WASM
 * model at the composition root.
 *
 * Never reads credentials from the environment; all configuration is
 * injected via the constructor.
 */
import type { ProviderAdapter } from './types';
import type { ClassifyRequest, ClassificationResult, ProviderInfo } from '../types';

/** Configuration for the local provider adapter. */
export interface LocalProviderConfig {
  providerId?: string;
  model?: string;
}

/**
 * Local provider adapter.
 *
 * Injects a simple heuristic classifier by default. A real local model
 * can be wired by subclassing or providing a custom classify function
 * at the composition root.
 */
export class LocalProvider implements ProviderAdapter {
  readonly providerId: string;
  readonly providerInfo: ProviderInfo;

  constructor(config: LocalProviderConfig = {}) {
    const id = config.providerId ?? 'local';
    this.providerId = id;
    this.providerInfo = {
      id,
      name: 'Local Classifier',
      locality: 'local',
      supportedCapabilities: ['classification'],
      endpoint: null,
      authType: null,
      model: config.model ?? 'local-heuristic-v1',
    };
  }

  async classify(request: ClassifyRequest): Promise<ClassificationResult> {
    // Default implementation: heuristic matching via normalized merchant.
    // Replace with real local-model inference in production.
    const merchant = request.normalizedMerchant ?? request.rawMerchant ?? '';
    const categoryId = this.heuristicLookup(merchant);

    return {
      categoryId: categoryId || 'uncategorized',
      confidence: categoryId ? 0.6 : 0,
      alternatives: [],
      rationale: categoryId
        ? `Local heuristic matched merchant pattern for "${merchant}"`
        : 'No local heuristic match found',
      model: this.providerInfo.model ?? 'local-heuristic-v1',
    };
  }

  /**
   * Very simplistic merchant → category lookup.
   * Production would use an embedding model or ONNX classifier.
   */
  private heuristicLookup(merchant: string): string {
    const upper = merchant.toUpperCase();
    if (upper.includes('AMAZON') || upper.includes('WALMART')) return 'cat_shopping';
    if (upper.includes('STARBUCKS') || upper.includes('RESTAURANT') || upper.includes('CAFE')) return 'cat_food_dining';
    if (upper.includes('SHELL') || upper.includes('EXXON') || upper.includes('GAS')) return 'cat_transport';
    if (upper.includes('RENT') || upper.includes('MORTGAGE')) return 'cat_housing';
    return '';
  }
}
