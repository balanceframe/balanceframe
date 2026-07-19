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
} from './types';
import type { ProviderAdapter } from './providers/types';

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
}

/**
 * Orchestrates classification of unresolved candidates.
 *
 * Thread-safe: each classify call is independent and produces new
 * Suggestion instances. No shared mutable state.
 */
export class Orchestrator {
  private readonly providers: ProviderAdapter[];
  private readonly policy: PolicyEngine;
  private readonly redactor: Redactor;
  private readonly promptVersion: string;
  private readonly providerTimeoutMs: number | undefined;
  private readonly signal: AbortSignal | undefined;

  constructor(config: OrchestratorConfig) {
    this.providers = config.providers;
    this.policy = config.policy;
    this.redactor = config.redactor;
    this.promptVersion = config.promptVersion;
    this.providerTimeoutMs = config.providerTimeoutMs;
    this.signal = config.signal;
  }

  /**
   * Classify one or more unresolved candidates.
   *
   * Returns one Suggestion per candidate — never throws. Errors from
   * provider calls, policy denials, or validation failures are captured
   * in the Suggestion's errors array.
   */
  async classify(candidates: UnresolvedCandidate[]): Promise<Suggestion[]> {
    const results: Suggestion[] = [];

    for (const candidate of candidates) {
      const suggestion = await this.classifyOne(candidate);
      results.push(suggestion);
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

    // Build classify request with deadline race
    let timeoutId: NodeJS.Timeout | undefined;
    const abortController = new AbortController();
    const timeoutMs = this.providerTimeoutMs ?? (isExternal ? 30_000 : 10_000);

    // Race the adapter call against a hard deadline — enforces timeout even for
    // adapters that do not check the AbortSignal.
    const timeoutPromise = new Promise<ClassificationResult>((_, reject) => {
      timeoutId = setTimeout(() => {
        abortController.abort();
        reject(Object.assign(new Error(`provider timeout after ${timeoutMs}ms`), { name: 'TimeoutError' }));
      }, timeoutMs);

      // Link external caller cancellation signal
      if (this.signal) {
        if (this.signal.aborted) {
          clearTimeout(timeoutId);
          reject(Object.assign(new Error('classify cancelled'), { name: 'AbortError' }));
          return;
        }
        this.signal.addEventListener('abort', () => {
          clearTimeout(timeoutId);
          abortController.abort();
          reject(Object.assign(new Error('classify cancelled'), { name: 'AbortError' }));
        }, { once: true });
      }
    });

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
      // In a real system, these come from the protocol snapshot
      categoryNames: {},
      categoryGroups: {},
      signal: abortController.signal,
    };

    // Call provider
    let result: ClassificationResult;
    try {
      result = await Promise.race([chosenAdapter.classify(request), timeoutPromise]);
    } catch (err) {
      clearTimeout(timeoutId);
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
      alternatives: validated.alternatives.map((a) => ({ ...a })),
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
}
