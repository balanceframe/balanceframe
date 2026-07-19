/**
 * Provider-neutral classifier orchestration.
 *
 * Accepts unresolved candidates from Rust, applies policy and redaction,
 * routes to the appropriate provider, validates output with Zod, and
 * produces immutable Suggestion data. All provider errors are caught and
 * converted to error-bearing Suggestion entries — no provider failure
 * propagates to the caller or blocks manual review.
 */
import { createHash, randomUUID } from 'node:crypto';
import { classificationResultSchema } from './validators';
import type {
  UnresolvedCandidate,
  ClassifyRequest,
  ClassificationResult,
  Suggestion,
  PolicyEngine,
  Redactor,
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

  constructor(config: OrchestratorConfig) {
    this.providers = config.providers;
    this.policy = config.policy;
    this.redactor = config.redactor;
    this.promptVersion = config.promptVersion;
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

    // Build classify request
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
    };

    // Call provider
    let result: ClassificationResult;
    try {
      result = await chosenAdapter.classify(request);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Normalize to stable error code: use err.name for custom subclasses;
      // for plain Error extract the prefix before ":" as the type identifier.
      const errorCode = err instanceof Error && err.name !== 'Error'
        ? err.name
        : err instanceof Error
          ? err.message.includes(':')
            ? err.message.split(':')[0].trim()
            : 'Error'
          : 'Unknown';
      return this.errorSuggestion(candidate, message, chosenProviderInfo.id, errorCode);
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

    // Compute hash from payload
    const payload = JSON.stringify({
      candidate: candidate.transactionId,
      categoryId: validated.categoryId,
      model: validated.model,
    });
    const hash = createHash('sha256').update(payload).digest('hex');

    return {
      id: randomUUID(),
      spaceId: candidate.spaceId,
      connectionId: candidate.connectionId,
      budgetId: candidate.budgetId,
      transactionId: candidate.transactionId,
      transactionVersion: candidate.transactionVersion,
      rawMerchant: candidate.rawMerchant ?? null,
      normalizedMerchant: candidate.normalizedMerchant ?? null,
      researchSummary: null,
      categoryId: validated.categoryId,
      alternatives: validated.alternatives,
      rationale: validated.rationale,
      provenance: {
        provider: chosenProviderInfo.id,
        model: validated.model,
        promptVersion: this.promptVersion,
        policyVersion: this.policy.policyVersion,
      },
      createdAt: new Date().toISOString(),
      hash,
      errors: [],
      deterministicEvidence: candidate.deterministicEvidence,
    };
  }

  /**
   * Build an error-bearing Suggestion.
   *
   * categoryId is left empty to indicate classification failure.
   * The caller can still use the Suggestion to route to manual review.
   */
  private errorSuggestion(
    candidate: UnresolvedCandidate,
    errorMessage: string,
    providerId: string | null,
    errorCode: string = 'Error',
  ): Suggestion {
    const payload = JSON.stringify({
      candidate: candidate.transactionId,
      error: errorMessage,
    });
    const hash = createHash('sha256').update(payload).digest('hex');

    return {
      id: randomUUID(),
      spaceId: candidate.spaceId,
      connectionId: candidate.connectionId,
      budgetId: candidate.budgetId,
      transactionId: candidate.transactionId,
      transactionVersion: candidate.transactionVersion,
      rawMerchant: candidate.rawMerchant ?? null,
      normalizedMerchant: candidate.normalizedMerchant ?? null,
      researchSummary: null,
      categoryId: '',
      alternatives: [],
      rationale: '',
      provenance: {
        provider: providerId ?? '',
        model: '',
        promptVersion: this.promptVersion,
        policyVersion: this.policy.policyVersion,
      },
      createdAt: new Date().toISOString(),
      hash,
      errors: [errorCode, errorMessage],
      deterministicEvidence: candidate.deterministicEvidence,
    };
  }
}
