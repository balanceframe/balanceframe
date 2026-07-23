/**
 * Provider-neutral classifier orchestration.
 *
 * Accepts unresolved candidates from Rust, applies policy and redaction,
 * routes to the appropriate provider, validates output with Zod, and
 * produces immutable Suggestion data. All provider errors are caught and
 * converted to error-bearing Suggestion entries — no provider failure
 * propagates to the caller or blocks manual review.
 *
 * Hardening:
 * - Candidate eligibility checks (non-empty transactionId, transactionVersion, budgetId)
 * - Deterministic SHA-256 idempotency keys (same input = same hash)
 * - Provider deadlines via AbortSignal
 * - Immutable / deeply-copied output
 */
import { createHash, randomUUID } from 'node:crypto';
import { classificationResultSchema } from './validators';
import type { ClassificationResultParsed } from './validators';
import type {
  UnresolvedCandidate,
  ClassifyRequest,
  ClassificationResult,
  Suggestion,
  PolicyEngine,
  Redactor,
  ProviderInfo,
  AuthoritativeLayer,
  LayerResult,
} from './types';
import type { ProviderAdapter } from './providers/types';

type TimeoutHandle = ReturnType<typeof setTimeout>;
/** Dependency-injection configuration for the orchestrator. */
export interface OrchestratorConfig {
  /** Registered provider adapters — injectable. */
  providers: ProviderAdapter[];
  /** Capability policy engine. */
  policy: PolicyEngine;
  /** Content redactor. */
  redactor: Redactor;
  /** Current prompt template version. */
  promptVersion: string;
  /** Per-provider-call timeout in milliseconds. Overrides the default (10s local, 30s external). */
  providerTimeoutMs?: number;
  /** External AbortSignal for caller-initiated cancellation across all classify calls. */
  signal?: AbortSignal;
  /** Ordered authoritative layers checked before provider routing. */
  layers?: AuthoritativeLayer[];
  /** Maximum concurrent classify calls to providers. Default: no limit. */
  maxConcurrency?: number;
}

/**
 * Orchestrates classification of unresolved candidates.
 *
 * Thread-safe: each classify call is independent and produces new
 * Suggestion objects — no shared mutable state.
 */
export class Orchestrator {
  private readonly providers: ProviderAdapter[];
  private readonly policy: PolicyEngine;
  private readonly redactor: Redactor;
  private readonly promptVersion: string;
  private readonly providerTimeoutMs: number | undefined;
  private readonly signal: AbortSignal | undefined;
  private readonly layers: AuthoritativeLayer[] | undefined;
  private readonly maxConcurrency: number | undefined;
  /** Track abort listener for cleanup after each classifyOne call. */
  private _abortListener: (() => void) | null = null;

  constructor(config: OrchestratorConfig) {
    this.providers = config.providers;
    this.policy = config.policy;
    this.redactor = config.redactor;
    this.promptVersion = config.promptVersion;
    this.providerTimeoutMs = config.providerTimeoutMs;
    this.signal = config.signal;
    this.layers = config.layers;
    this.maxConcurrency = config.maxConcurrency;
  }

  /**
   * Classify one or more unresolved candidates.
   * Classify one or more unresolved candidates.
   *
   * Returns one Suggestion per candidate — never throws. Errors from
   * provider calls, policy denials, or validation failures are captured
   * in the Suggestion's errors array.
   *
   * When maxConcurrency is set, at most that many classifyOne calls run
   * simultaneously, preventing provider flooding.
   */
  async classify(candidates: UnresolvedCandidate[]): Promise<Suggestion[]> {
    const total = candidates.length;
    const results: Suggestion[] = new Array(total);
    const maxConc = this.maxConcurrency ?? total;

    if (maxConc <= 0 || maxConc >= total) {
      // No concurrency limit or limit >= total — process serially
      for (let i = 0; i < total; i++) {
        results[i] = await this.classifyOne(candidates[i]!);
      }
      return results;
    }

    // Bounded concurrency: use a simple sliding-window approach
    let nextIdx = 0;
    const inFlight = new Set<Promise<void>>();

    async function startOne(
      orchestrator: Orchestrator,
      candidate: UnresolvedCandidate,
      idx: number,
    ): Promise<void> {
      results[idx] = await orchestrator.classifyOne(candidate);
    }

    while (nextIdx < total || inFlight.size > 0) {
      // Fill the window up to maxConcurrency
      while (nextIdx < total && inFlight.size < maxConc) {
        const idx = nextIdx++;
        const promise = startOne(this, candidates[idx]!, idx).finally(() => {
          inFlight.delete(promise);
        });
        inFlight.add(promise);
      }

      if (inFlight.size > 0) {
        // Wait for at least one to finish
        await Promise.race(inFlight);
      }
    }

    return results;
  }
  private async classifyOne(candidate: UnresolvedCandidate): Promise<Suggestion> {
    // Check candidate eligibility
    const eligibilityError = this.checkEligibility(candidate);
    if (eligibilityError) {
      return this.errorSuggestion(candidate, eligibilityError, null);
    }

    // Check policy
    if (!this.policy.isEnabled('classification')) {
      return this.errorSuggestion(candidate, 'classification disabled by policy', null);
    }
    // Run authoritative layers before falling through to providers
    const layerSuggestion = await this.resolveLayers(candidate);
    if (layerSuggestion) {
      return layerSuggestion;
    }

    // Find eligible providers for this capability
    const registry = this.providers.map((p) => p.providerInfo);
    const allowed = this.policy.getAllowedProviders('classification', registry);

    if (allowed.length === 0) {
      return this.errorSuggestion(candidate, 'no eligible providers for classification', null);
    }

    // Pick the first eligible provider
    const chosenProviderInfo = allowed[0];
    const chosenAdapter = this.providers.find(
      (p) => p.providerId === chosenProviderInfo.id,
    );
    if (!chosenAdapter) {
      return this.errorSuggestion(
        candidate,
        `provider ${chosenProviderInfo.id} not found in registry`,
        chosenProviderInfo.id,
      );
    }

    // Redact for external calls
    const isExternal = chosenProviderInfo.locality === 'external';
    const preparedCandidate = isExternal
      ? this.redactor.forExternal(candidate)
      : this.redactor.forLocal(candidate);

    // Build classify request with deadline race and category context
    let timeoutId: TimeoutHandle | undefined;
    const abortController = new AbortController();
    const timeoutMs = this.providerTimeoutMs ?? (isExternal ? 30_000 : 10_000);

    // Race the adapter call against a hard deadline — enforces timeout even for
    // adapters that do not check the AbortSignal.
    let rejectTimeout!: (reason: unknown) => void;
    const timeoutPromise = new Promise<ClassificationResult>((_resolve, reject) => {
      rejectTimeout = reject;
    });
    timeoutId = setTimeout(() => {
      abortController.abort();
      rejectTimeout(Object.assign(new Error(`provider timeout after ${timeoutMs}ms`), { name: 'TimeoutError' }));
    }, timeoutMs);

    // Link external caller cancellation signal — cleanup after call
    const abortHandler = () => {
      clearTimeout(timeoutId);
      abortController.abort();
      rejectTimeout(Object.assign(new Error('classify cancelled'), { name: 'AbortError' }));
    };
    if (this.signal) {
      if (this.signal.aborted) {
        clearTimeout(timeoutId);
        rejectTimeout(Object.assign(new Error('classify cancelled'), { name: 'AbortError' }));
      } else {
        this.signal.addEventListener('abort', abortHandler, { once: true });
      }
    }

    const request: ClassifyRequest = {
      transactionId: preparedCandidate.transactionId,
      description: preparedCandidate.description,
      notes: preparedCandidate.notes,
      rawMerchant: preparedCandidate.rawMerchant,
      normalizedMerchant: preparedCandidate.normalizedMerchant,
      importedPayee: preparedCandidate.importedPayee,
      amountMinorUnits: preparedCandidate.amountMinorUnits,
      currency: preparedCandidate.currency,
      date: preparedCandidate.date,
      categoryId: preparedCandidate.categoryId,
      // Category context from protocol snapshot — carried on the candidate
      allowedCategoryIds: preparedCandidate.allowedCategoryIds ?? [],
      categoryNames: preparedCandidate.categoryNames ?? {},
      categoryGroups: preparedCandidate.categoryGroups ?? {},
      signal: abortController.signal,
    };

    // Call provider
    let result: ClassificationResult;
    try {
      result = await Promise.race([chosenAdapter.classify(request), timeoutPromise]);
    } catch (err) {
      clearTimeout(timeoutId);
      if (this.signal) {
        this.signal.removeEventListener('abort', abortHandler);
      }
      const message = err instanceof Error ? err.message : String(err);
      const errorCode = err instanceof Error && err.name !== 'Error'
        ? err.name
        : err instanceof Error
          ? err.message.includes(':')
            ? err.message.split(':')[0].trim()
            : 'Error'
          : 'Unknown';
      return this.errorSuggestion(candidate, message, chosenProviderInfo.id, errorCode);
    } finally {
      clearTimeout(timeoutId);
      if (this.signal) {
        this.signal.removeEventListener('abort', abortHandler);
      }
    }

    // Validate provider output
    const parsed = classificationResultSchema.safeParse(result);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => i.message).join('; ');
      return this.errorSuggestion(
        candidate,
        `provider output validation failed: ${issues}`,
        chosenProviderInfo.id,
      );
    }

    const validated = parsed.data;

    // Category allowlist validation: if allowedCategoryIds is non-empty, the
    // returned categoryId must be in the allowed set.
    const allowedIds = candidate.allowedCategoryIds ?? [];
    if (allowedIds.length > 0 && !allowedIds.includes(validated.categoryId)) {
      return this.errorSuggestion(
        candidate,
        `provider returned category "${validated.categoryId}" which is not in the allowed category set`,
        chosenProviderInfo.id,
        'CATEGORY_NOT_ALLOWED',
      );
    }

    // Build the suggestion with deterministic idempotency key
    return this.buildSuggestion(candidate, validated, chosenProviderInfo);
  }

  /**
   * Check candidate eligibility: requires non-empty transactionId,
   * transactionVersion, and budgetId.
   *
   * @returns Error message string or null if eligible.
   */
  private checkEligibility(candidate: UnresolvedCandidate): string | null {
    if (!candidate.transactionId) {
      return 'candidate missing transactionId';
    }
    if (!candidate.transactionVersion) {
      return 'candidate missing transactionVersion';
    }
    if (!candidate.budgetId) {
      return 'candidate missing budgetId';
    }
    return null;
  }

  /**
   * Build a deterministic hash from candidate + provider output.
   *
   * @returns SHA-256 hex string.
   */
  private buildHash(candidate: UnresolvedCandidate, categoryId: string, model: string, errorMessage?: string): string {
    const payload = JSON.stringify({
      candidate: candidate.transactionId,
      transactionVersion: candidate.transactionVersion,
      budgetId: candidate.budgetId,
      categoryId,
      model,
      error: errorMessage ?? null,
    });
    return createHash('sha256').update(payload).digest('hex');
  }

  /**
   * Build a fully-populated Suggestion.
   *
   * Performs a deep copy of nested objects to ensure immutability.
   */
  private buildSuggestion(
    candidate: UnresolvedCandidate,
    validated: ClassificationResultParsed,
    providerInfo: ProviderInfo,
  ): Suggestion {
    const hash = this.buildHash(candidate, validated.categoryId, validated.model);
    const now = new Date().toISOString();
    const evidence = validated.rationale ? [validated.rationale] : [];

    return {
      // Canonical protocol fields
      transactionId: candidate.transactionId,
      proposedCategoryId: validated.categoryId,
      // Backward-compatible convenience aliases
      categoryId: validated.categoryId,
      categoryName: '', // populated from protocol snapshot in production
      confidence: validated.confidence ?? 0,
      reasonCodes: ['provider-classification'],
      evidence,

      // Phase 2 fields
      spaceId: candidate.spaceId,
      connectionId: candidate.connectionId,
      budgetId: candidate.budgetId,
      transactionVersion: candidate.transactionVersion,
      rawMerchant: candidate.rawMerchant ?? null,
      normalizedMerchant: candidate.normalizedMerchant ?? null,
      researchSummary: null,
      alternativeCategoryIds: validated.alternatives.map((a) => a.categoryId),
      rationale: validated.rationale,
      provider: providerInfo.id,
      model: validated.model,
      promptVersion: this.promptVersion,
      inferencePolicyVersion: this.policy.policyVersion,
      createdAt: now,
      payloadHash: hash,
      hash,
      provenance: {
        provider: providerInfo.id,
        model: validated.model,
        promptVersion: this.promptVersion,
        policyVersion: this.policy.policyVersion,
      },

      // Inference-specific extras
      id: randomUUID(),
      alternatives: validated.alternatives.map((a) => ({ categoryId: a.categoryId, reason: a.reason })),
      errors: [],
      deterministicEvidence: structuredClone(candidate.deterministicEvidence),
    };
  }

  /**
   * Build an error-bearing Suggestion.
   *
   * proposedCategoryId is left empty to indicate classification failure.
   * The caller can still use the Suggestion to route to manual review.
   */
  private errorSuggestion(
    candidate: UnresolvedCandidate,
    errorMessage: string,
    providerId: string | null,
    errorCode: string = 'Error',
  ): Suggestion {
    const hash = this.buildHash(candidate, '', '', errorMessage);
    const now = new Date().toISOString();

    return {
      // Canonical protocol fields
      transactionId: candidate.transactionId,
      proposedCategoryId: '',
      categoryName: '',
      confidence: 0,
      // Backward-compatible convenience aliases
      categoryId: '',
      reasonCodes: [errorCode],
      evidence: [errorMessage],

      // Phase 2 fields
      spaceId: candidate.spaceId,
      connectionId: candidate.connectionId,
      budgetId: candidate.budgetId,
      transactionVersion: candidate.transactionVersion,
      rawMerchant: candidate.rawMerchant ?? null,
      normalizedMerchant: candidate.normalizedMerchant ?? null,
      researchSummary: null,
      alternativeCategoryIds: [],
      rationale: errorMessage,
      provider: providerId ?? '',
      model: '',
      promptVersion: this.promptVersion,
      inferencePolicyVersion: this.policy.policyVersion,
      createdAt: now,
      payloadHash: hash,
      hash,
      provenance: {
        provider: providerId ?? '',
        model: '',
        promptVersion: this.promptVersion,
        policyVersion: this.policy.policyVersion,
      },

      // Inference-specific extras
      id: randomUUID(),
      alternatives: [],
      errors: [errorCode, errorMessage],
      deterministicEvidence: structuredClone(candidate.deterministicEvidence),
    };
  }

  /**
   * Run authoritative layers in registration order.
   *
   * Returns a Suggestion if any layer resolves or blocks the candidate,
   * or null if all layers return unresolved/unavailable.
   */
  private async resolveLayers(candidate: UnresolvedCandidate): Promise<Suggestion | null> {
    if (!this.layers || this.layers.length === 0) {
      return null;
    }

    for (const layer of this.layers) {
      let result: LayerResult;
      try {
        result = await layer.resolve(candidate);
      } catch {
        // Layer error → treat as unavailable, continue to next layer
        continue;
      }

      if (result.outcome === 'resolved') {
        return this.buildLayerSuggestion(candidate, result, layer.layerId);
      }

      if (result.outcome === 'blocked') {
        return this.buildLayerBlockedSuggestion(candidate, result, layer.layerId);
      }

      // 'unresolved' or 'unavailable' — fall through to next layer or provider
    }

    return null;
  }

  /**
   * Build a Suggestion from an authoritative layer resolve.
   *
   * No provider was called; the layer output IS the suggestion. Model
   * is empty to distinguish from provider-based classification.
   */
  private buildLayerSuggestion(
    candidate: UnresolvedCandidate,
    result: LayerResult,
    layerId: string,
  ): Suggestion {
    const categoryId = result.categoryId ?? '';
    const hash = this.buildHash(candidate, categoryId, `${layerId}-layer`);
    const now = new Date().toISOString();

    return {
      transactionId: candidate.transactionId,
      proposedCategoryId: categoryId,
      categoryId,
      categoryName: '',
      confidence: 1,
      reasonCodes: [`${layerId}-resolved`],
      evidence: result.rationale ? [result.rationale] : [],

      spaceId: candidate.spaceId,
      connectionId: candidate.connectionId,
      budgetId: candidate.budgetId,
      transactionVersion: candidate.transactionVersion,
      rawMerchant: candidate.rawMerchant ?? null,
      normalizedMerchant: candidate.normalizedMerchant ?? null,
      researchSummary: null,
      alternativeCategoryIds: [],
      rationale: result.rationale ?? '',
      provider: `${layerId}-layer`,
      model: '',
      promptVersion: this.promptVersion,
      inferencePolicyVersion: this.policy.policyVersion,
      createdAt: now,
      payloadHash: hash,
      hash,
      provenance: {
        provider: `${layerId}-layer`,
        model: '',
        promptVersion: this.promptVersion,
        policyVersion: this.policy.policyVersion,
      },

      id: randomUUID(),
      alternatives: [],
      errors: [],
      deterministicEvidence: structuredClone(candidate.deterministicEvidence),
    };
  }

  /**
   * Build an error-bearing Suggestion for a layer-blocked candidate.
   *
   * proposedCategoryId is empty to route to manual review. Model is empty
   * since no provider was involved.
   */
  private buildLayerBlockedSuggestion(
    candidate: UnresolvedCandidate,
    result: LayerResult,
    layerId: string,
  ): Suggestion {
    const errorMessage = result.error ?? result.rationale ?? `blocked by ${layerId}`;
    const hash = this.buildHash(candidate, '', '', errorMessage);
    const now = new Date().toISOString();

    return {
      transactionId: candidate.transactionId,
      proposedCategoryId: '',
      categoryId: '',
      categoryName: '',
      confidence: 0,
      reasonCodes: [`${layerId}-blocked`],
      evidence: [errorMessage],

      spaceId: candidate.spaceId,
      connectionId: candidate.connectionId,
      budgetId: candidate.budgetId,
      transactionVersion: candidate.transactionVersion,
      rawMerchant: candidate.rawMerchant ?? null,
      normalizedMerchant: candidate.normalizedMerchant ?? null,
      researchSummary: null,
      alternativeCategoryIds: [],
      rationale: errorMessage,
      provider: `${layerId}-layer`,
      model: '',
      promptVersion: this.promptVersion,
      inferencePolicyVersion: this.policy.policyVersion,
      createdAt: now,
      payloadHash: hash,
      hash,
      provenance: {
        provider: `${layerId}-layer`,
        model: '',
        promptVersion: this.promptVersion,
        policyVersion: this.policy.policyVersion,
      },

      id: randomUUID(),
      alternatives: [],
      errors: [errorMessage],
      deterministicEvidence: structuredClone(candidate.deterministicEvidence),
    };
  }
 }
