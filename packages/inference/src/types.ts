/**
 * Core types for the provider-neutral inference layer.
 *
 * An unresolved candidate arrives from Rust after deterministic processing
 * leaves it ambiguous. The inference layer classifies it via an allowed
 * provider, producing an immutable Suggestion that never mutates the ledger.
 *
 * The Suggestion type is a superset of the protocol-generated
 * @balanceframe/protocol-generated Suggestion — all protocol fields are
 * present plus inference-specific metadata (id, hash, errors,
 * deterministicEvidence, alternatives).
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
  /** AbortSignal for provider deadline/cancellation. */
  signal?: AbortSignal;
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
 * Superset of the protocol-generated Suggestion (camelCase). The canonical
 * protocol fields (transactionId, proposedCategoryId, etc.) are present
 * alongside inference-specific metadata.
 *
 * Suggestion data lives outside Actual. The proposedCategoryId is a proposal:
 * Rust validates it against the current snapshot, transaction version,
 * policy, and blockers before any effect.
 */
export interface Suggestion {
  // ---- Canonical protocol fields (aligned with protcol-generated) ----
  /** Stable transaction identifier within the Actual budget. */
  transactionId: string;
  /** Proposed category identifier (empty string = uncategorize/remove). */
  proposedCategoryId: string;
  /** Backward-compatible convenience alias for proposedCategoryId. */
  categoryId: string;
  /** Human-readable name of the proposed category. */
  categoryName: string;
  /** Model confidence score (metadata only, never authorization). */
  confidence: number;
  /** Machine-readable reason codes for this suggestion. */
  reasonCodes: string[];
  /** Evidence strings supporting the suggestion. */
  evidence: string[];

  // ---- Phase 2: Suggestion-only classifier fields ----
  /** Stable space identifier for multi-space deployments. */
  spaceId: string;
  /** Connection identifier for the data source. */
  connectionId: string;
  /** Budget identifier for the current budget cycle. */
  budgetId: string;
  /** Version identifier for the transaction, used for staleness detection. */
  transactionVersion: string;
  /** Raw merchant name as recorded in the transaction. */
  rawMerchant: string | null;
  /** Normalized merchant name for cross-reference matching. */
  normalizedMerchant: string | null;
  /** Optional research summary from merchant research provider. */
  researchSummary: string | null;
  /** Alternative category identifiers that were considered. */
  alternativeCategoryIds: string[];
  /** Free-text rationale for the suggestion. */
  rationale: string;
  /** Inference provider identifier (e.g. "openai", "local"). */
  provider: string;
  /** Model identifier used for this suggestion. */
  model: string;
  /** Version of the prompt template used. */
  promptVersion: string;
  /** Version of the inference policy at time of suggestion. */
  inferencePolicyVersion: string;
  /** ISO-8601 timestamp of suggestion creation. */
  createdAt: string;
  /** Hash of the suggestion payload for integrity verification. */
  payloadHash: string;
  /** Provenance metadata (provider, model, version chain). */
  provenance: Provenance;
  /** Backward-compatible convenience alias for payloadHash. */
  hash: string;

  // ---- Inference-specific extras (not in protocol) ----
  /** Stable unique identifier for this suggestion. */
  id: string;
  /** Alternative category proposals with reasons. */
  alternatives: Alternative[];
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
