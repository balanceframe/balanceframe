/**
 * Capability policy engine.
 *
 * Controls per-capability routing decisions (disabled/local-only/external-allowed)
 * and applies explicit provider allowlists to filter the provider registry.
 */
import type {
  Capability,
  CapabilityState,
  PolicyConfig,
  PolicyEngine,
  ProviderInfo,
} from './types';

/**
 * Create a policy engine from configuration.
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

  function getCapabilityState(capability: Capability): CapabilityState {
    return capabilities[capability];
  }

  function isEnabled(capability: Capability): boolean {
    return capabilities[capability] !== 'disabled';
  }

  function canRouteToExternal(capability: Capability): boolean {
    return capabilities[capability] === 'external-allowed';
  }

  function getAllowedProviders(
    capability: Capability,
    registry: ProviderInfo[],
  ): ProviderInfo[] {
    const state = capabilities[capability];
    if (state === 'disabled') {
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
