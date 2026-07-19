/**
 * Provider adapter interface.
 *
 * Adapters are injectable implementations — local or external — without
 * hardcoded credentials. Tests inject fake adapters; production wiring
 * provides real HttpClient / API-key resolution at the composition root.
 */
import type { ClassifyRequest, ClassificationResult, ProviderInfo } from '../types';

export interface ProviderAdapter {
  readonly providerId: string;
  readonly providerInfo: ProviderInfo;

  /**
   * Classify a single unresolved transaction candidate.
   *
   * Returns a ClassificationResult on success. Throws on timeout, network
   * outage, or malformed response from the underlying model endpoint.
   * The orchestrator catches all errors and converts them to error-bearing
   * Suggestion entries — no provider error propagates to the caller.
   *
   * Adapters SHOULD check `request.signal` for provider-initiated cancellation
   * and abort inflight work when the signal is aborted.
   */
  classify(request: ClassifyRequest): Promise<ClassificationResult>;
}
