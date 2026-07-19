/**
 * Capability policy engine.
 *
 * Controls per-capability routing decisions (disabled/local-only/external-allowed)
 * and applies explicit provider allowlists to filter the provider registry.
 *
 * Fail-closed: missing capability states, invalid provider metadata, and
 * missing allowlists all result in denial (empty provider list).
 */
import type {
  Capability,
  CapabilityState,
  PolicyConfig,
  PolicyEngine,
  ProviderInfo,
} from './types';

/** Default state for any capability not explicitly configured — disabled. */
const DEFAULT_STATE: CapabilityState = 'disabled';

/** Valid provider locality values. */
const VALID_LOCALITIES = new Set(['local', 'external']);

/**
 * Create a policy engine from configuration.
 *
 * @param config - Policy configuration with capabilities and allowlists.
 * @returns A PolicyEngine instance.
 */
export function createPolicyEngine(config: PolicyConfig): PolicyEngine {
  const { capabilities, providerAllowlists, policyVersion } = config;

  const allowlistMap = new Map<Capability, Set<string>>();
  for (const entry of providerAllowlists) {
    const existing = allowlistMap.get(entry.capability) ?? new Set();
    for (const id of entry.allowedProviderIds) {
      existing.add(id);
    }
    allowlistMap.set(entry.capability, existing);
  }

  /** All capabilities that have an explicit allowlist entry. */
  const allowlistedCapabilities = new Set(allowlistMap.keys());

  function getCapabilityState(capability: Capability): CapabilityState {
    return capabilities[capability] ?? DEFAULT_STATE;
  }

  function isEnabled(capability: Capability): boolean {
    return getCapabilityState(capability) !== 'disabled';
  }

  function canRouteToExternal(capability: Capability): boolean {
    return getCapabilityState(capability) === 'external-allowed';
  }

  /**
   * Validate provider metadata for routing decisions.
   *
   * - locality must be a valid value ('local' or 'external')
   * - external providers must have a non-null endpoint and non-null authType
   */
  function isValidProvider(provider: ProviderInfo): boolean {
    if (!VALID_LOCALITIES.has(provider.locality)) {
      return false;
    }
    if (provider.locality === 'external') {
      if (!provider.endpoint) return false;
      if (!provider.authType || provider.authType === 'none') return false;
    }
    return true;
  }

  function getAllowedProviders(
    capability: Capability,
    registry: ProviderInfo[],
  ): ProviderInfo[] {
    const state = getCapabilityState(capability);
    if (state === 'disabled') {
      return [];
    }

    // Fail-closed: if no allowlist exists for this capability, deny all
    if (!allowlistedCapabilities.has(capability)) {
      return [];
    }

    // Start with all registered providers that support this capability
    let candidates = registry.filter((p) =>
      p.supportedCapabilities.includes(capability),
    );

    // Apply explicit allowlist if configured
    const allowedIds = allowlistMap.get(capability);
    if (allowedIds !== undefined) {
      candidates = candidates.filter((p) => allowedIds.has(p.id));
    }

    // Filter out providers with invalid metadata
    candidates = candidates.filter(isValidProvider);

    // Local-only: restrict to local providers
    if (state === 'local-only') {
      candidates = candidates.filter((p) => p.locality === 'local');
    }

    return candidates;
  }

  return {
    policyVersion,
    getCapabilityState,
    isEnabled,
    canRouteToExternal,
    getAllowedProviders,
  };
}
