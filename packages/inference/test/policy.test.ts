/**
 * Tests for capability policy engine.
 *
 * Covers: per-capability states (disabled/local-only/external-allowed),
 * explicit provider allowlists, local-only routing, external denial.
 */
import { describe, it, expect } from 'vitest';
import { createPolicyEngine } from '../src/policy';
import type { CapabilityPolicies, ProviderInfo, ProviderAllowlist } from '../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultPolicies(overrides: Partial<CapabilityPolicies> = {}): CapabilityPolicies {
  return {
    classification: 'local-only',
    merchantResearch: 'disabled',
    conversation: 'disabled',
    telemetry: 'disabled',
    ...overrides,
  };
}

function localProvider(overrides: Partial<ProviderInfo> = {}): ProviderInfo {
  return {
    id: 'local-default',
    name: 'Local Default',
    locality: 'local',
    supportedCapabilities: ['classification'],
    endpoint: null,
    authType: null,
    model: 'local-v1',
    ...overrides,
  };
}

function externalProvider(overrides: Partial<ProviderInfo> = {}): ProviderInfo {
  return {
    id: 'openai-gpt4',
    name: 'OpenAI GPT-4',
    locality: 'external',
    supportedCapabilities: ['classification', 'merchantResearch'],
    endpoint: 'https://api.openai.com/v1',
    authType: 'api-key',
    model: 'gpt-4',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Per-capability policy states
// ---------------------------------------------------------------------------

describe('capability policy', () => {
  it('returns disabled for all capabilities when classification is disabled', () => {
    const policies: CapabilityPolicies = {
      classification: 'disabled',
      merchantResearch: 'disabled',
      conversation: 'disabled',
      telemetry: 'disabled',
    };
    const engine = createPolicyEngine({
      capabilities: policies,
      providerAllowlists: [],
      policyVersion: '1.0',
    });
    expect(engine.getCapabilityState('classification')).toBe('disabled');
    expect(engine.isEnabled('classification')).toBe(false);
  });

  it('returns local-only when classification is set to local-only', () => {
    const engine = createPolicyEngine({
      capabilities: defaultPolicies({ classification: 'local-only' }),
      providerAllowlists: [],
      policyVersion: '1.0',
    });
    expect(engine.getCapabilityState('classification')).toBe('local-only');
    expect(engine.isEnabled('classification')).toBe(true);
  });

  it('returns external-allowed when classification is set to external-allowed', () => {
    const engine = createPolicyEngine({
      capabilities: defaultPolicies({ classification: 'external-allowed' }),
      providerAllowlists: [],
      policyVersion: '1.0',
    });
    expect(engine.getCapabilityState('classification')).toBe('external-allowed');
    expect(engine.isEnabled('classification')).toBe(true);
  });

  it('supports independent policies per capability', () => {
    const engine = createPolicyEngine({
      capabilities: {
        classification: 'external-allowed',
        merchantResearch: 'local-only',
        conversation: 'disabled',
        telemetry: 'disabled',
      },
      providerAllowlists: [],
      policyVersion: '1.0',
    });
    expect(engine.getCapabilityState('classification')).toBe('external-allowed');
    expect(engine.getCapabilityState('merchantResearch')).toBe('local-only');
    expect(engine.getCapabilityState('conversation')).toBe('disabled');
    expect(engine.getCapabilityState('telemetry')).toBe('disabled');
  });
});

// ---------------------------------------------------------------------------
// Provider allowlists
// ---------------------------------------------------------------------------

describe('provider allowlists', () => {
  it('routes to allowed providers only', () => {
    const allowlists: ProviderAllowlist[] = [
      { capability: 'classification', allowedProviderIds: ['local-default'] },
    ];
    const engine = createPolicyEngine({
      capabilities: defaultPolicies({ classification: 'local-only' }),
      providerAllowlists: allowlists,
      policyVersion: '1.0',
    });
    const allowed = engine.getAllowedProviders('classification', [
      localProvider(),
      externalProvider(),
    ]);
    expect(allowed).toHaveLength(1);
    expect(allowed[0].id).toBe('local-default');
  });

  it('returns empty list when allowlist is empty for a capability', () => {
    const engine = createPolicyEngine({
      capabilities: defaultPolicies({ classification: 'local-only' }),
      providerAllowlists: [
        { capability: 'classification', allowedProviderIds: [] },
      ],
      policyVersion: '1.0',
    });
    const allowed = engine.getAllowedProviders('classification', [localProvider()]);
    expect(allowed).toHaveLength(0);
  });

  it('respects multiple allowed providers', () => {
    const allowlists: ProviderAllowlist[] = [
      { capability: 'classification', allowedProviderIds: ['local-default', 'openai-gpt4'] },
    ];
    const engine = createPolicyEngine({
      capabilities: defaultPolicies({ classification: 'external-allowed' }),
      providerAllowlists: allowlists,
      policyVersion: '1.0',
    });
    const allowed = engine.getAllowedProviders('classification', [
      localProvider(),
      externalProvider(),
    ]);
    expect(allowed).toHaveLength(2);
  });

  it('ignores provider IDs not in the registry', () => {
    const allowlists: ProviderAllowlist[] = [
      { capability: 'classification', allowedProviderIds: ['unknown-provider'] },
    ];
    const engine = createPolicyEngine({
      capabilities: defaultPolicies({ classification: 'external-allowed' }),
      providerAllowlists: allowlists,
      policyVersion: '1.0',
    });
    const allowed = engine.getAllowedProviders('classification', [
      localProvider(),
    ]);
    expect(allowed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Local-only routing
// ---------------------------------------------------------------------------

describe('local-only routing', () => {
  it('allows only local providers when classification is local-only', () => {
    const allowlists: ProviderAllowlist[] = [
      { capability: 'classification', allowedProviderIds: ['local-default', 'openai-gpt4'] },
    ];
    const engine = createPolicyEngine({
      capabilities: defaultPolicies({ classification: 'local-only' }),
      providerAllowlists: allowlists,
      policyVersion: '1.0',
    });
    const allowed = engine.getAllowedProviders('classification', [
      localProvider(),
      externalProvider(),
    ]);
    expect(allowed).toHaveLength(1);
    expect(allowed[0].locality).toBe('local');
  });

  it('does not include external providers when classification is local-only', () => {
    const allowlists: ProviderAllowlist[] = [
      { capability: 'classification', allowedProviderIds: ['openai-gpt4'] },
    ];
    const engine = createPolicyEngine({
      capabilities: defaultPolicies({ classification: 'local-only' }),
      providerAllowlists: allowlists,
      policyVersion: '1.0',
    });
    const allowed = engine.getAllowedProviders('classification', [
      externalProvider(),
    ]);
    expect(allowed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// External denial
// ---------------------------------------------------------------------------

describe('external denial', () => {
  it('denies external providers when capability is local-only', () => {
    const engine = createPolicyEngine({
      capabilities: defaultPolicies({ classification: 'local-only' }),
      providerAllowlists: [
        { capability: 'classification', allowedProviderIds: ['openai-gpt4'] },
      ],
      policyVersion: '1.0',
    });
    expect(engine.canRouteToExternal('classification')).toBe(false);
  });

  it('allows external providers when capability is external-allowed', () => {
    const engine = createPolicyEngine({
      capabilities: defaultPolicies({ classification: 'external-allowed' }),
      providerAllowlists: [
        { capability: 'classification', allowedProviderIds: ['openai-gpt4'] },
      ],
      policyVersion: '1.0',
    });
    expect(engine.canRouteToExternal('classification')).toBe(true);
  });

  it('denies external for disabled capability', () => {
    const engine = createPolicyEngine({
      capabilities: defaultPolicies({ classification: 'disabled' }),
      providerAllowlists: [],
      policyVersion: '1.0',
    });
    expect(engine.canRouteToExternal('classification')).toBe(false);
  });

  it('preserves policy version in engine metadata', () => {
    const engine = createPolicyEngine({
      capabilities: defaultPolicies(),
      providerAllowlists: [],
      policyVersion: '2.3',
    });
    expect(engine.policyVersion).toBe('2.3');
  });
});
