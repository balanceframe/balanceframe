/**
 * Local (on-device) provider adapter.
 *
 * DETERMINISTIC LIMITED FALLBACK — NOT CALIBRATED MODEL OUTPUT
 *
 * This adapter uses a simple keyword/rule-based heuristic lookup to provide
 * a best-guess category when no real provider can classify the candidate.
 * It is NOT a calibrated model — confidence scores are fixed constants
 * (0.6 for a match, 0 for no match) and must NOT be interpreted as
 * statistical likelihood or model confidence.
 *
 * Designed to be replaced with an ONNX/TFLite/WASM model at the
 * composition root for production use.
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
