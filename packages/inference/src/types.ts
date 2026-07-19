/**
 * Core types for the provider-neutral inference layer.
 *
 * An unresolved candidate arrives from Rust after deterministic processing
 * leaves it ambiguous. The inference layer classifies it via an allowed
 * provider, producing an immutable Suggestion that never mutates the ledger.
 */

// ---------------------------------------------------------------------------
// Capability policy
// ---------------------------------------------------------------------------

/** Named inference capability with independent policy. */
export type Capability = 'classification' | 'merchantResearch' | 'conversation' | 'telemetry';

/** Per-capability state machine. */
export type CapabilityState = 'disabled' | 'local-only' | 'external-allowed';

/** Independent policies for each capability. */
export interface CapabilityPolicies {
  classification: CapabilityState;
  merchantResearch: CapabilityState;
  conversation: CapabilityState;
  telemetry: CapabilityState;
}

/** Explicit provider allowlist entry for one capability. */
export interface ProviderAllowlist {
  capability: Capability;
  allowedProviderIds: string[];
}

// ---------------------------------------------------------------------------
// Provider metadata
// ---------------------------------------------------------------------------

export type ProviderLocality = 'local' | 'external';
export type AuthType = 'none' | 'api-key' | 'oauth';

export interface ProviderInfo {
  id: string;
  name: string;
  locality: ProviderLocality;
  supportedCapabilities: Capability[];
  endpoint: string | null;
  authType: AuthType | null;
  model: string | null;
}

// ---------------------------------------------------------------------------
// Unresolved candidate (from Rust deterministic processing)
// ---------------------------------------------------------------------------

/** A candidate that Rust left unresolved and needs provider classification. */
export interface UnresolvedCandidate {
  transactionId: string;
  transactionVersion: string;
  budgetId: string;
  spaceId: string;
  connectionId: string;
  rawMerchant: string | null;
  normalizedMerchant: string | null;
  description: string | null;
  notes: string | null;
  importedPayee: string | null;
  amountMinorUnits: string;
  currency: string;
  date: string;
  categoryId: string | null;
  importedId: string | null;
  deterministicEvidence: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Classification — request / result
// ---------------------------------------------------------------------------

/** Data sent to a provider adapter for classification. */
export interface ClassifyRequest {
  transactionId: string;
  /** Redacted or raw description depending on locality. */
  description: string | null;
  /** Redacted or raw notes depending on locality. */
  notes: string | null;
  rawMerchant: string | null;
  normalizedMerchant: string | null;
  importedPayee: string | null;
  amountMinorUnits: string;
  currency: string;
  date: string;
  categoryId: string | null;
  /** Budget category names keyed by id — for provider context. */
  categoryNames: Record<string, string>;
  /** Category group names keyed by id — for provider context. */
  categoryGroups: Record<string, string>;
}

/** Raw classification result from a provider adapter. */
export interface ClassificationResult {
  categoryId: string;
  /** Model confidence score — metadata, never authorization. */
  confidence: number | null;
  /** Alternative category suggestions. */
  alternatives: Alternative[];
  /** Free-text rationale from the provider. */
  rationale: string;
  /** Model identifier that produced this result. */
  model: string;
}

export interface Alternative {
  categoryId: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Immutable suggestion — the output contract
// ---------------------------------------------------------------------------

/** Provenance chain for a suggestion. */
export interface Provenance {
  provider: string;
  model: string;
  promptVersion: string;
  policyVersion: string;
}

/**
 * Immutable suggestion produced by the inference layer.
 *
 * Suggestion data lives outside Actual. The categoryId is a proposal:
 * Rust validates it against the current snapshot, transaction version,
 * policy, and blockers before any effect.
 */
export interface Suggestion {
  /** Stable unique identifier for this suggestion. */
  id: string;
  spaceId: string;
  connectionId: string;
  budgetId: string;
  transactionId: string;
  transactionVersion: string;
  rawMerchant: string | null;
  normalizedMerchant: string | null;
  /** Optional research summary — populated by merchantResearch capability. */
  researchSummary: string | null;
  /** Proposed category. Empty string when classification failed. */
  categoryId: string;
  /** Alternative category proposals. */
  alternatives: Alternative[];
  /** Free-text rationale. */
  rationale: string;
  provenance: Provenance;
  createdAt: string;
  /**
   * Cryptographic-quality hash of the payload for integrity verification.
   * Not a placeholder — real SHA-256 in production; hex string here.
   */
  hash: string;
  /** Error messages. Empty array = success. */
  errors: string[];
  /** Deterministic evidence from the unresolved candidate. */
  deterministicEvidence: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Policy engine configuration
// ---------------------------------------------------------------------------

/** Input to create a policy engine. */
export interface PolicyConfig {
  capabilities: CapabilityPolicies;
  providerAllowlists: ProviderAllowlist[];
  policyVersion: string;
}

/** Policy engine interface returned by createPolicyEngine. */
export interface PolicyEngine {
  readonly policyVersion: string;
  getCapabilityState(capability: Capability): CapabilityState;
  isEnabled(capability: Capability): boolean;
  canRouteToExternal(capability: Capability): boolean;
  getAllowedProviders(
    capability: Capability,
    registry: ProviderInfo[],
  ): ProviderInfo[];
}

// ---------------------------------------------------------------------------
// Redactor interface
// ---------------------------------------------------------------------------

export interface Redactor {
  /** Redact sensitive fields for an external provider call. */
  forExternal(candidate: UnresolvedCandidate): UnresolvedCandidate;
  /** Return fields unchanged for a local provider call. */
  forLocal(candidate: UnresolvedCandidate): UnresolvedCandidate;
}

// ---------------------------------------------------------------------------
// Orchestrator configuration
// ---------------------------------------------------------------------------

export interface OrchestratorConfig {
  providers: Array<{ providerId: string; providerInfo: ProviderInfo; classify: (request: ClassifyRequest) => Promise<ClassificationResult> }>;
  policy: PolicyEngine;
  redactor: Redactor;
  promptVersion: string;
}
